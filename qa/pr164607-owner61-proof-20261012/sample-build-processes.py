#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from dataclasses import dataclass
from typing import TextIO


SAMPLE_INTERVAL_SECONDS = 10
KNOWN_COMMANDS = {
    "corepack": "corepack",
    "esbuild": "esbuild",
    "node": "node",
    "pnpm": "pnpm",
    "pnpm.cjs": "pnpm",
    "rollup": "rollup",
    "tsc": "tsc",
    "tsdown": "tsdown",
    "tsx": "tsx",
    "vite": "vite",
}
STARTUP_WRITER = "scripts/write-cli-startup-metadata.ts"


@dataclass(frozen=True)
class ProcessStat:
    pid: int
    ppid: int
    state: str
    user_ticks: int
    system_ticks: int
    start_ticks: int
    rss_bytes: int

    @property
    def identity(self) -> tuple[int, int]:
        return (self.pid, self.start_ticks)


def read_process_stat(pid: int, page_size: int, sample_resources: bool = False) -> ProcessStat | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_bytes()
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None

    closing_paren = raw.rfind(b")")
    if closing_paren < 0:
        return None
    fields = raw[closing_paren + 1 :].split()
    if len(fields) < (22 if sample_resources else 20):
        return None
    try:
        return ProcessStat(
            pid=pid,
            ppid=int(fields[1]),
            state=fields[0].decode("ascii"),
            user_ticks=int(fields[11]) if sample_resources else 0,
            system_ticks=int(fields[12]) if sample_resources else 0,
            start_ticks=int(fields[19]),
            rss_bytes=max(0, int(fields[21])) * page_size if sample_resources else 0,
        )
    except (UnicodeDecodeError, ValueError):
        return None


def read_process_table(page_size: int) -> dict[int, ProcessStat]:
    processes: dict[int, ProcessStat] = {}
    try:
        entries = os.scandir("/proc")
    except OSError:
        return processes
    with entries:
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            process = read_process_stat(int(entry.name), page_size)
            if process is not None:
                processes[process.pid] = process
    return processes


def command_label(process: ProcessStat, page_size: int) -> str | None:
    try:
        arguments = Path(f"/proc/{process.pid}/cmdline").read_bytes().split(b"\0")
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None
    current = read_process_stat(process.pid, page_size)
    if current is None or current.identity != process.identity:
        return None

    executable = os.path.basename(os.fsdecode(arguments[0])) if arguments and arguments[0] else ""
    for raw_argument in arguments[1:]:
        if not raw_argument:
            continue
        argument = os.fsdecode(raw_argument)
        if argument == STARTUP_WRITER or argument.endswith(f"/{STARTUP_WRITER}"):
            return "write-cli-startup-metadata"

    label = KNOWN_COMMANDS.get(executable)
    if label is not None:
        return label
    for raw_argument in arguments[1:]:
        if not raw_argument:
            continue
        name = os.path.basename(os.fsdecode(raw_argument))
        label = KNOWN_COMMANDS.get(name)
        if label is not None:
            return label
    return None


class ProcessRecorder:
    def __init__(self, stream: TextIO, root_pid: int, started_at: float) -> None:
        self.stream = stream
        self.root_pid = root_pid
        self.started_at = started_at
        self.page_size = os.sysconf("SC_PAGE_SIZE")
        self.clock_ticks = os.sysconf("SC_CLK_TCK")
        self.active: dict[tuple[int, int], ProcessStat] = {}
        self.last: dict[tuple[int, int], ProcessStat] = {}
        self.labels: dict[tuple[int, int], str | None] = {}

    def write_row(self, row: dict[str, object]) -> None:
        self.stream.write(json.dumps(row, separators=(",", ":")) + "\n")
        self.stream.flush()

    def capture(self) -> None:
        processes = read_process_table(self.page_size)
        identity_by_pid = {process.pid: process.identity for process in processes.values()}
        root = processes.get(self.root_pid)
        root_identity = root.identity if root is not None else None
        eligible = {
            identity
            for identity in self.active
            if identity_by_pid.get(identity[0]) == identity
        }
        if root_identity is not None:
            eligible.add(root_identity)

        parent_by_identity: dict[tuple[int, int], tuple[int, int] | None] = {}
        for process in processes.values():
            parent_by_identity[process.identity] = identity_by_pid.get(process.ppid)

        changed = True
        while changed:
            changed = False
            for process in processes.values():
                if (
                    process.identity not in eligible
                    and parent_by_identity[process.identity] in eligible
                ):
                    eligible.add(process.identity)
                    changed = True

        ordered = sorted(eligible, key=lambda identity: (identity != root_identity, identity[0]))
        measured = {
            identity: process
            for identity in ordered
            if (process := read_process_stat(identity[0], self.page_size, sample_resources=True))
            is not None
            and process.identity == identity
        }
        ordered = [identity for identity in ordered if identity in measured]
        elapsed = round(time.monotonic() - self.started_at, 3)
        for identity in ordered:
            process = measured[identity]
            label = command_label(process, self.page_size)
            self.labels[identity] = label
            self.write_row(
                {
                    "type": "process",
                    "pid": process.pid,
                    "ppid": process.ppid,
                    "state": process.state,
                    "elapsed_seconds": elapsed,
                    "cpu_seconds": round(
                        (process.user_ticks + process.system_ticks) / self.clock_ticks,
                        3,
                    ),
                    "rss_bytes": process.rss_bytes,
                    "command_label": label,
                }
            )
        self.active = measured
        self.last.update(self.active)

        exited = [identity for identity in self.last if identity not in self.active]
        for identity in exited:
            previous = self.last.pop(identity)
            self.write_row(
                {
                    "type": "process",
                    "pid": previous.pid,
                    "ppid": previous.ppid,
                    "state": "exited",
                    "elapsed_seconds": elapsed,
                    "cpu_seconds": round(
                        (previous.user_ticks + previous.system_ticks) / self.clock_ticks,
                        3,
                    ),
                    "rss_bytes": previous.rss_bytes,
                    "command_label": self.labels.pop(identity, None),
                }
            )


def stop_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    process.wait()


def shell_status(returncode: int) -> int:
    return 128 + abs(returncode) if returncode < 0 else returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a build command is required after --")

    handlers = {
        signum: signal.signal(signum, lambda _signum, _frame: None)
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }
    pending_signals: list[int] = []
    for signum in handlers:
        signal.signal(signum, lambda value, _frame: pending_signals.append(value))

    output: TextIO | None = None
    process: subprocess.Popen[bytes] | None = None
    try:
        try:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output = output_path.open("w", encoding="utf-8", newline="\n")
        except OSError:
            output = None

        started_at = time.monotonic()
        try:
            process = subprocess.Popen(command, start_new_session=True)
        except OSError:
            return 127

        try:
            recorder = ProcessRecorder(output, process.pid, started_at) if output else None
        except (OSError, ValueError):
            recorder = None
        if recorder is not None:
            try:
                recorder.capture()
            except Exception:
                pass

        next_sample = started_at + SAMPLE_INTERVAL_SECONDS
        while process.poll() is None:
            if pending_signals:
                stop_process_group(process)
                break
            timeout = max(0.05, min(1.0, next_sample - time.monotonic()))
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                pass
            if process.poll() is not None:
                break
            if time.monotonic() >= next_sample:
                if recorder is not None:
                    try:
                        recorder.capture()
                    except Exception:
                        pass
                next_sample = time.monotonic() + SAMPLE_INTERVAL_SECONDS

        return shell_status(process.wait())
    except BaseException:
        if process is not None:
            stop_process_group(process)
        raise
    finally:
        if output is not None:
            output.close()
        for signum, handler in handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())
