import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, withTestTimeout } from "../../../test/helpers/promise.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "../../infra/startup-maintenance-required.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import {
  createCloseMock,
  createGatewayServer,
  createRuntimeWithExitSignal,
  originalPlatformDescriptor,
  setPlatform,
  waitForLoopCondition,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

function isolateSupervisorEnv() {
  const env = captureEnv([...SUPERVISOR_HINT_ENV_VARS]);
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    deleteTestEnvValue(key);
  }
  return env;
}

export function registerGatewayStartupFailureTests(
  gatewayLog: ReturnType<typeof import("./run-loop.test-support.js").createGatewayLogger>,
  acquireGatewayLock: Mock,
): void {
  const createStartupOperations = async () => {
    const { createGatewayStartupOperations } = await import("./run-loop-startup.js");
    return createGatewayStartupOperations();
  };
  const rejectTrackedStartup = async (
    operations: Awaited<ReturnType<typeof createStartupOperations>>,
    error: unknown,
  ) => {
    await expect(
      operations.run(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  };

  it("drains after acknowledging the exact tracked startup failure", async () => {
    const operations = await createStartupOperations();
    const failure = new Error("handled startup failure");
    await rejectTrackedStartup(operations, failure);
    operations.close();
    operations.acknowledgeHandledFailure(failure);
    await expect(operations.drain()).resolves.toBeUndefined();
  });

  it("keeps a tracked startup failure when acknowledgement has a different identity", async () => {
    const operations = await createStartupOperations();
    const failure = new Error("startup failure");
    await rejectTrackedStartup(operations, failure);
    operations.close();
    operations.acknowledgeHandledFailure(new Error("different failure"));
    await expect(operations.drain()).rejects.toBe(failure);
  });

  it("preserves a second tracked startup failure after acknowledging the first", async () => {
    const operations = await createStartupOperations();
    const handledFailure = new Error("handled prerequisite failure");
    const unrelatedFailure = new Error("unrelated startup failure");
    await rejectTrackedStartup(operations, handledFailure);
    await rejectTrackedStartup(operations, unrelatedFailure);
    operations.close();
    operations.acknowledgeHandledFailure(handledFailure);
    await expect(operations.drain()).rejects.toBe(unrelatedFailure);
  });

  it("keeps an unacknowledged tracked startup failure fatal at drain", async () => {
    const operations = await createStartupOperations();
    const failure = new Error("unacknowledged startup failure");
    await rejectTrackedStartup(operations, failure);
    operations.close();
    await expect(operations.drain()).rejects.toBe(failure);
  });

  it("joins recovery cleanup failure after shutdown without masking the failure", async () => {
    const { createGatewayRestartRecovery } = await import("./run-loop-startup.js");
    const failureStarted = createDeferredCore();
    const finishFailedRecovery = createDeferredCore();
    const failedRecovery = createGatewayRestartRecovery(
      {
        onRestartStartupFailure: async () => {
          failureStarted.resolve();
          await finishFailedRecovery.promise;
          throw new Error("recovery cleanup failed");
        },
      },
      gatewayLog,
      null,
    );
    const failedAttempt = failedRecovery.attempt(new Error("startup failed"));
    await awaitGateBeforeSettlement(
      failureStarted.promise,
      failedAttempt,
      "recovery attempt settled before its handler started",
    );
    failedRecovery.abort();
    const failedCleanup = failedRecovery.waitForCleanup();
    finishFailedRecovery.resolve();
    await expect(failedAttempt).resolves.toBe(false);
    await expect(failedCleanup).rejects.toThrow("recovery cleanup failed");
  });

  const runTrackedStartupStop = async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const {
          TailscaleBackendAuthenticationRequiredError,
          waitForTailscaleBackendReady,
          waitForTailscaleBackendRunning,
        } = await import("../../infra/tailscale-backend-ready.js");
        const processExec = await import("../../process/exec.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const close = createCloseMock();
        const releaseLock = vi.fn(async () => {});
        acquireGatewayLock.mockResolvedValueOnce({ release: releaseLock });
        const statusCommand = { bin: "sudo", prefix: ["-n", "tailscale"] };
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async (options) => {
            const startupOperation = options?.startupOperation;
            if (!startupOperation) {
              throw new Error("expected the run loop to provide tracked startup ownership");
            }
            return await startupOperation(async (signal) => {
              try {
                await waitForTailscaleBackendReady({
                  ...statusCommand,
                  managedMode: "serve",
                  info: vi.fn(),
                  signal,
                });
              } catch (error) {
                startupError = error;
                throw error;
              }
              return createGatewayServer(close);
            });
          });
        const { runtime, exited } = createRuntimeWithExitSignal();
        const recoveryWaitStarted = createDeferredCore();
        const recoveryAbortObserved = createDeferredCore();
        const recoveryWaitCleanup = createDeferredCore();
        const recoverySettled = createDeferredCore();
        let startupError: unknown;
        let statusCalls = 0;
        const statusExec = vi
          .spyOn(processExec, "runExec")
          .mockImplementation(async (_command, _args, options) => {
            statusCalls += 1;
            if (statusCalls === 1) {
              return {
                stdout: JSON.stringify({ BackendState: "NeedsLogin" }),
                stderr: "",
              };
            }
            if (statusCalls !== 2) {
              throw new Error("unexpected extra Tailscale status call");
            }
            recoveryWaitStarted.resolve();
            const signal = typeof options === "object" ? options.signal : undefined;
            if (!signal) {
              throw new Error("expected the tracked recovery waiter to receive cancellation");
            }
            return await new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
              const rejectAfterCleanup = () => {
                recoveryAbortObserved.resolve();
                void recoveryWaitCleanup.promise.then(() => {
                  reject(new DOMException("Tailscale wait cancelled", "AbortError"));
                });
              };
              if (signal.aborted) {
                rejectAfterCleanup();
              } else {
                signal.addEventListener("abort", rejectAfterCleanup, { once: true });
              }
            });
          });
        const onRestartStartupFailure = vi.fn(async (error: unknown, signal: AbortSignal) => {
          expect(error).toBe(startupError);
          expect(error).toBeInstanceOf(TailscaleBackendAuthenticationRequiredError);
          try {
            await waitForTailscaleBackendRunning({
              ...statusCommand,
              info: vi.fn(),
              signal,
            });
            return "completed" as const;
          } finally {
            recoverySettled.resolve();
          }
        });
        const loop = runGatewayLoop({ start, runtime, onRestartStartupFailure });
        let loopSettled = false;
        void loop.then(
          () => {
            loopSettled = true;
          },
          () => {
            loopSettled = true;
          },
        );
        let shutdownRequested = false;
        let recoveryEntered = false;
        try {
          await awaitGateBeforeSettlement(
            recoveryWaitStarted.promise,
            loop,
            "Gateway loop settled before the tracked startup failure entered prerequisite recovery",
          );
          recoveryEntered = true;
          expect(statusExec).toHaveBeenCalledTimes(2);
          expect(statusExec.mock.calls.map(([command, args]) => [command, args])).toEqual([
            ["sudo", ["-n", "tailscale", "status", "--json"]],
            ["sudo", ["-n", "tailscale", "status", "--json"]],
          ]);
          expect(onRestartStartupFailure).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          captureSignal("SIGTERM")();
          shutdownRequested = true;
          await awaitGateBeforeSettlement(
            recoveryAbortObserved.promise,
            exited,
            "Gateway exited before cancelling the real Tailscale prerequisite waiter",
          );
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(releaseLock).not.toHaveBeenCalled();
          recoveryWaitCleanup.resolve();
          await awaitGateBeforeSettlement(
            recoverySettled.promise,
            exited,
            "Gateway exited before joining the cancelled tracked prerequisite waiter",
          );
          const stopExitCode = await exited;
          expect(
            stopExitCode,
            stopExitCode === 1
              ? "tracked startup shutdown returned one instead of zero"
              : "tracked startup shutdown exit code",
          ).toBe(0);
          expect(statusExec).toHaveBeenCalledTimes(2);
          expect(onRestartStartupFailure).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          expect(releaseLock).toHaveBeenCalledOnce();
        } finally {
          try {
            recoveryWaitCleanup.resolve();
            if (recoveryEntered && !shutdownRequested) {
              captureSignal("SIGTERM")();
              await exited;
            } else if (!loopSettled && runtime.exit.mock.calls.length === 0) {
              captureSignal("SIGTERM")();
              await exited;
            }
          } finally {
            statusExec.mockRestore();
          }
        }
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  };

  it("joins the real Tailscale prerequisite waiter when shutdown cancels recovery", async () => {
    await runTrackedStartupStop();
  });

  it("parks supervised Serve startup after clean close and retries once after Running", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const firstClose = createCloseMock();
        const secondClose = createCloseMock();
        const recoveryStarted = createDeferredCore();
        const allowRecovery = createDeferredCore();
        const secondStartup = createDeferredCore();
        const releaseLock = vi.fn(async () => {});
        const releaseRestartLock = vi.fn(async () => {});
        acquireGatewayLock
          .mockResolvedValueOnce({ release: releaseLock })
          .mockResolvedValueOnce({ release: releaseRestartLock });
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(firstClose, Promise.reject(startupError)),
          )
          .mockImplementationOnce(async () =>
            createGatewayServer(secondClose, secondStartup.promise),
          );
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const onRestartStartupFailure = vi.fn(async (error: unknown, signal: AbortSignal) => {
          expect(error).toBe(startupError);
          expect(signal.aborted).toBe(false);
          expect(firstClose).toHaveBeenCalledExactlyOnceWith({ reason: "gateway startup failed" });
          recoveryStarted.resolve();
          await allowRecovery.promise;
          return "completed" as const;
        });
        const loop = runGatewayLoop({ start, runtime, completeBoot, onRestartStartupFailure });
        let loopFinished = false;
        void loop.then(
          () => {
            loopFinished = true;
          },
          () => {
            loopFinished = true;
          },
        );
        try {
          await awaitGateBeforeSettlement(
            recoveryStarted.promise,
            loop,
            "Gateway loop settled before supervised Serve recovery started",
          );
          expect(start).toHaveBeenCalledOnce();
          expect(firstClose).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledOnce();
          expect(releaseLock).not.toHaveBeenCalled();
          expect(completeBoot).toHaveBeenCalledOnce();
          expect(completeBoot).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: "startup_failed",
              startupReason: "gateway.tailscale_authentication_required",
              reason: expect.stringContaining("NeedsLogin"),
            }),
          );
          expect(runtime.exit).not.toHaveBeenCalled();

          allowRecovery.resolve();
          await waitForLoopCondition(
            () => start.mock.calls.length === 2,
            "expected exactly one retry after the backend recovery handler completed",
          );
          expect(start).toHaveBeenCalledTimes(2);
          expect(firstClose).toHaveBeenCalledOnce();
          expect(releaseLock).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
          expect(releaseRestartLock).not.toHaveBeenCalled();
          expect(secondClose).not.toHaveBeenCalled();
          expect(gatewayLog.error).not.toHaveBeenCalledWith(
            expect.stringContaining("openclaw doctor --fix"),
          );

          secondStartup.resolve();
          await awaitGateBeforeSettlement(
            new Promise<void>((resolve) => {
              setImmediate(resolve);
            }),
            loop,
            "Gateway loop settled before the successful retry entered its running loop",
          );
          const stop = captureSignal("SIGTERM");
          stop();
          await expect(exited).resolves.toBe(0);
          expect(releaseLock).toHaveBeenCalledOnce();
          expect(releaseRestartLock).toHaveBeenCalledOnce();
          expect(start).toHaveBeenCalledTimes(2);
          expect(onRestartStartupFailure).toHaveBeenCalledOnce();
        } finally {
          allowRecovery.resolve();
          secondStartup.resolve();
          if (runtime.exit.mock.calls.length === 0 && !loopFinished) {
            captureSignal("SIGTERM")();
            await exited;
          }
        }
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("keeps cleanup failures as startup failures instead of parking them", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async () => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const close = vi.fn(async () => {
          throw new Error("Tailscale route cleanup failed");
        });
        const { runtime } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const onRestartStartupFailure = vi.fn();
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(close, Promise.reject(startupError)),
          );

        await expect(
          runGatewayLoop({ start, runtime, completeBoot, onRestartStartupFailure }),
        ).rejects.toBeInstanceOf(GatewayStartupCleanupError);
        expect(close).toHaveBeenCalledOnce();
        expect(onRestartStartupFailure).not.toHaveBeenCalled();
        expect(completeBoot).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "startup_failed" }),
        );
        expect(completeBoot).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "startup_failed", reason: startupError.message }),
        );
        expect(completeBoot).not.toHaveBeenCalledWith(
          expect.objectContaining({ startupReason: "gateway.tailscale_authentication_required" }),
        );
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("releases parked custody before a contended normal restart reacquire", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    setTestEnvValue("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
    try {
      await withIsolatedSignals(async () => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const firstClose = createCloseMock();
        const releaseLock = vi.fn(async () => {});
        acquireGatewayLock
          .mockResolvedValueOnce({ release: releaseLock })
          .mockRejectedValueOnce(new Error("lock already owned"));
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(firstClose, Promise.reject(startupError)),
          );
        const { runtime, exited } = createRuntimeWithExitSignal();
        const recoveryStarted = createDeferredCore();
        const onRestartStartupFailure = vi.fn(async () => {
          recoveryStarted.resolve();
          return "completed" as const;
        });
        const loop = runGatewayLoop({ start, runtime, onRestartStartupFailure });

        await awaitGateBeforeSettlement(
          recoveryStarted.promise,
          loop,
          "Gateway loop settled before parked startup recovery started",
        );
        expect(acquireGatewayLock).toHaveBeenCalledOnce();
        expect(releaseLock).not.toHaveBeenCalled();
        await expect(exited).resolves.toBe(1);
        expect(start).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(releaseLock).toHaveBeenCalledOnce();
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("does not park a foreground Gateway for Tailscale authentication requirements", async () => {
    const env = isolateSupervisorEnv();
    setPlatform("linux");
    try {
      await withIsolatedSignals(async () => {
        const { TailscaleBackendAuthenticationRequiredError } =
          await import("../../infra/tailscale-backend-ready.js");
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new TailscaleBackendAuthenticationRequiredError(
          "NeedsLogin",
          "serve",
          {
            bin: "tailscale",
            prefix: [],
          },
        );
        const close = createCloseMock();
        const { runtime } = createRuntimeWithExitSignal();
        const onRestartStartupFailure = vi.fn();
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () =>
            createGatewayServer(close, Promise.reject(startupError)),
          );
        await expect(runGatewayLoop({ start, runtime, onRestartStartupFailure })).rejects.toBe(
          startupError,
        );
        expect(close).toHaveBeenCalledExactlyOnceWith({ reason: "gateway startup failed" });
        expect(onRestartStartupFailure).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    } finally {
      env.restore();
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it.each([
    { cleanup: "clean", supervised: false, platform: "linux" },
    { cleanup: "failed", supervised: false, platform: "linux" },
    { cleanup: "maintenance", supervised: false, platform: "linux" },
    { cleanup: "unrepaired", supervised: false, platform: "linux" },
    { cleanup: "unrepaired", supervised: true, platform: "linux" },
    { cleanup: "repair-failed", supervised: false, platform: "linux" },
    { cleanup: "repair-failed", supervised: true, platform: "linux" },
    { cleanup: "unavailable", supervised: false, platform: "win32" },
    { cleanup: "unavailable", supervised: true, platform: "win32" },
  ] as const)(
    "fences replacement after deferred startup with $cleanup cleanup (supervised=$supervised, platform=$platform)",
    async ({ cleanup, supervised, platform }) => {
      setPlatform(platform);
      vi.clearAllMocks();
      if (supervised) {
        setTestEnvValue(
          platform === "win32" ? "OPENCLAW_WINDOWS_TASK_NAME" : "OPENCLAW_SYSTEMD_UNIT",
          "openclaw-gateway",
        );
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runGatewayLoop } = await import("./run-loop.js");
        const firstStartup = createDeferredCore();
        const firstStarted = createDeferredCore();
        const triageStarted = createDeferredCore();
        const manualRecovery = createDeferredCore();
        gatewayLog.error.mockImplementation((message: string) => {
          if (message.includes("Process will stay alive for manual recovery")) {
            manualRecovery.resolve();
          }
        });
        const thirdStarted = createDeferredCore();
        const { SessionStoreMigrationRequiredError } =
          await import("../../config/sessions/migration-required.js");
        const startupError =
          cleanup === "maintenance"
            ? new SessionStoreMigrationRequiredError("legacy session store requires migration")
            : new Error("gateway.bind: refused configuration");
        const cleanupError = new Error("replacement cleanup failed");
        const retryError = new Error("repaired configuration still refused");
        const closeFirst = createCloseMock();
        const closeSecond = createCloseMock();
        if (cleanup === "failed") {
          closeSecond.mockRejectedValueOnce(cleanupError);
        }
        const closeThird = createCloseMock();
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockImplementationOnce(async () => {
            firstStarted.resolve();
            return createGatewayServer(closeFirst, firstStartup.promise);
          })
          .mockImplementationOnce(async () =>
            createGatewayServer(closeSecond, Promise.reject(startupError)),
          )
          .mockImplementationOnce(async () => {
            thirdStarted.resolve();
            if (cleanup === "unrepaired") {
              throw retryError;
            }
            return createGatewayServer(closeThird);
          });
        const { runtime, exited } = createRuntimeWithExitSignal();
        const onRestartStartupFailure = vi.fn(async (error: unknown) => {
          triageStarted.resolve();
          expect(error).toBe(startupError);
          expect(closeSecond).toHaveBeenCalledExactlyOnceWith({ reason: "gateway startup failed" });
          return cleanup === "unavailable"
            ? undefined
            : cleanup === "repair-failed"
              ? ("failed" as const)
              : ("completed" as const);
        });
        const completeBoot = vi.fn();
        const loop = runGatewayLoop({ start, runtime, completeBoot, onRestartStartupFailure });
        const loopRejected = vi.fn<(error: unknown) => void>();
        const loopSettled = loop.catch(loopRejected);
        let stop: (() => void) | undefined;
        try {
          await Promise.race([firstStarted.promise, loopSettled]);
          expect(start).toHaveBeenCalledOnce();
          const restart = captureSignal("SIGUSR2");
          stop = captureSignal("SIGTERM");
          restart();
          await Promise.race([loopSettled, triageStarted.promise]);
          expect(closeSecond).toHaveBeenCalledExactlyOnceWith({
            reason: "gateway startup failed",
          });
          if (cleanup === "clean") {
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(loopRejected).not.toHaveBeenCalled();
            await withTestTimeout(
              thirdStarted.promise,
              1_000,
              "expected settled triage to restart the Gateway without another signal",
            );
            expect(start).toHaveBeenCalledTimes(3);
            stop();
            await expect(exited).resolves.toBe(0);
          } else if (supervised && (cleanup === "unrepaired" || cleanup === "repair-failed")) {
            await withTestTimeout(loopSettled, 1_000, "expected terminal startup refusal");
            const error = cleanup === "unrepaired" ? retryError : startupError;
            expect(loopRejected).toHaveBeenCalledExactlyOnceWith(error);
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(start).toHaveBeenCalledTimes(cleanup === "unrepaired" ? 3 : 2);
            expect(completeBoot).toHaveBeenLastCalledWith({
              outcome: "startup_failed",
              reason: error.message,
            });
          } else if (
            cleanup === "unavailable" ||
            cleanup === "unrepaired" ||
            cleanup === "repair-failed"
          ) {
            await withTestTimeout(
              Promise.race([manualRecovery.promise, loopSettled]),
              1_000,
              "expected manual recovery guidance",
            );
            expect(loopRejected).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(start).toHaveBeenCalledTimes(cleanup === "unrepaired" ? 3 : 2);
            const output = gatewayLog.error.mock.calls.flat().join("\n");
            expect(output).toContain(
              cleanup === "unrepaired" ? retryError.message : "gateway.bind",
            );
            expect(output).toContain("openclaw doctor --fix");
            if (platform === "win32") {
              expect(output).toContain(supervised ? "openclaw gateway restart" : "press Ctrl+C");
              expect(output).not.toContain("kill -USR2");
            } else {
              expect(output).toContain(`kill -USR2 ${process.pid}`);
              const recovered = createDeferredCore();
              start.mockReset().mockImplementation(async () => {
                recovered.resolve();
                return createGatewayServer(closeThird);
              });
              restart();
              await withTestTimeout(
                recovered.promise,
                1_000,
                "expected operator reload to restart the Gateway",
              );
            }
            stop();
            await expect(exited).resolves.toBe(0);
          } else if (cleanup === "maintenance") {
            expect(completeBoot).toHaveBeenCalledWith({
              outcome: "startup_failed",
              reason: startupError.message,
              startupReason: GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON,
            });
            expect(onRestartStartupFailure).not.toHaveBeenCalled();
            expect(loopRejected).toHaveBeenCalledExactlyOnceWith(startupError);
            expect(start).toHaveBeenCalledTimes(2);
          } else {
            expect(onRestartStartupFailure).not.toHaveBeenCalled();
            expect(loopRejected).toHaveBeenCalledOnce();
            await expect(loop).rejects.toBeInstanceOf(AggregateError);
            await expect(loop).rejects.toMatchObject({
              cause: startupError,
              errors: expect.arrayContaining([startupError, cleanupError]),
            });
            expect(start).toHaveBeenCalledTimes(2);
            expect(runtime.exit).not.toHaveBeenCalled();
          }
        } finally {
          gatewayLog.error.mockReset();
          firstStartup.resolve();
          await firstStartup.promise;
          if (
            loopRejected.mock.calls.length === 0 &&
            runtime.exit.mock.calls.length === 0 &&
            stop
          ) {
            stop();
            await exited;
          }
          if (loopRejected.mock.calls.length > 0) {
            await loopSettled;
          }
        }
      });
    },
  );

  it("keeps truncated startup failure reasons free of lone surrogates", async () => {
    await withIsolatedSignals(async () => {
      const failure = `${"a".repeat(499)}😀tail`;
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.js");
      await expect(
        runGatewayLoop({
          start: vi.fn(async () => {
            throw new Error(failure);
          }) as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
          completeBoot,
        }),
      ).rejects.toThrow(failure);

      const reason =
        (completeBoot.mock.calls[0]?.[0] as { reason?: string } | undefined)?.reason ?? "";
      expect(reason).toHaveLength(499);
      expect(Buffer.from(reason).toString()).toBe(reason);
    });
  });
}
