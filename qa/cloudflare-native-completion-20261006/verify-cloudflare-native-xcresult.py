#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


EXPECTED_SOURCE = "c6da5f742bdb0e850e023216af9c4ad5e140357e"
REQUIRED_SUITES = {
    "CloudflareAccessClientTests",
    "CloudflareAccessBrowserPresenterTests",
    "CloudflareAccessTransferTests",
    "CloudflareAccessSessionStoreTests",
    "GatewayAccessDeviceAuthBindingTests",
    "GatewayIngressControllerTests",
    "GatewayIngressLoginPreparationTests",
}
REQUIRED_CASES = {
    "SettingsHubVisualProofTests/testOlderDashboardShowsNativeGatewayUpgradeBanner()",
}
INPUT_PATHS = (
    "apps/ios/project.yml",
    "apps/ios/Sources/Gateway/CloudflareAccessClient.swift",
    "apps/ios/Sources/Gateway/CloudflareAccessBrowserPresenter.swift",
    "apps/ios/Sources/Gateway/CloudflareAccessTransfer.swift",
    "apps/ios/Sources/Gateway/CloudflareAccessSessionStore.swift",
    "apps/ios/Sources/Gateway/GatewayAccessDeviceAuthBinding.swift",
    "apps/ios/Sources/Gateway/GatewayIngressController.swift",
    "apps/ios/Sources/Settings/SettingsHubScreen.swift",
    "apps/ios/Tests/CloudflareAccessClientTests.swift",
    "apps/ios/Tests/CloudflareAccessBrowserPresenterTests.swift",
    "apps/ios/Tests/CloudflareAccessTransferTests.swift",
    "apps/ios/Tests/CloudflareAccessSessionStoreTests.swift",
    "apps/ios/Tests/GatewayAccessDeviceAuthBindingTests.swift",
    "apps/ios/Tests/GatewayIngressControllerTests.swift",
    "apps/ios/Tests/GatewayIngressActivationTests.swift",
    "apps/ios/Tests/GatewayIngressWireTests.swift",
    "apps/ios/Tests/GatewayIngressLoginPreparationTests.swift",
    "apps/ios/Tests/GatewayAccessRestartTests.swift",
    "apps/ios/Tests/SettingsHubTests.swift",
    "scripts/ios-access-restart-proof.py",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def xcresult_json(bundle: Path, command: str) -> dict:
    result = subprocess.run(
        ["xcrun", "xcresulttool", "get", "test-results", command, "--path", str(bundle)],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    document = json.loads(result.stdout)
    require(isinstance(document, dict), f"xcresult {command} response is not an object")
    return document


def descendants(value):
    if isinstance(value, dict):
        yield value
        for child in value.get("children", []):
            yield from descendants(child)
    elif isinstance(value, list):
        for child in value:
            yield from descendants(child)


def source_receipt(source_root: Path) -> tuple[str, dict[str, str]]:
    source = subprocess.run(
        ["git", "-C", str(source_root), "rev-parse", "--verify", "HEAD"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout.strip()
    require(source == EXPECTED_SOURCE, f"Unexpected source revision: {source}")
    hashes = {}
    for relative in INPUT_PATHS:
        path = source_root / relative
        require(path.is_file(), f"Missing hashed source input: {relative}")
        hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return source, hashes


def verify(bundle: Path, simulator: str) -> dict:
    require(bundle.is_dir() and bundle.suffix == ".xcresult", f"Missing xcresult bundle: {bundle}")
    summary = xcresult_json(bundle, "summary")
    tests = xcresult_json(bundle, "tests")

    total = summary.get("totalTestCount")
    require(
        summary.get("result") == "Passed"
        and type(total) is int
        and total > 0
        and summary.get("passedTests") == total
        and summary.get("failedTests") == 0
        and summary.get("skippedTests") == 0
        and summary.get("expectedFailures") == 0
        and summary.get("testFailures") == [],
        "Suite xcresult must pass with no failures, expected failures, or skips",
    )

    all_nodes = list(descendants(tests.get("testNodes", [])))
    bundles = [node for node in all_nodes if node.get("nodeType") == "Unit test bundle"]
    require(len(bundles) == 1 and bundles[0].get("name") == "OpenClawTests",
            "Expected exactly one OpenClawTests bundle")
    bundle_nodes = list(descendants(bundles[0].get("children", [])))
    cases = [node for node in bundle_nodes if node.get("nodeType") == "Test Case"]
    require(len(cases) == total, "xcresult case-node count differs from summary total")
    identifiers = [node.get("nodeIdentifier") for node in cases]
    require(all(isinstance(identifier, str) and "/" in identifier for identifier in identifiers),
            "xcresult contains a test case without a recognized identity")
    require(len(set(identifiers)) == len(identifiers), "xcresult contains duplicate test identities")
    require(all(node.get("result") == "Passed" for node in cases),
            "Every executed test case must pass")

    suite_counts = {suite: 0 for suite in REQUIRED_SUITES}
    exact_case_counts = {case: 0 for case in REQUIRED_CASES}
    for identifier in identifiers:
        if identifier in exact_case_counts:
            exact_case_counts[identifier] += 1
            continue
        suite = identifier.split("/", 1)[0]
        require(suite in suite_counts,
                f"Unexpected test executed outside the explicit selector set: {identifier}")
        suite_counts[suite] += 1

    require(all(count > 0 for count in suite_counts.values()),
            f"Missing required suite cases: {[name for name, count in suite_counts.items() if count == 0]}")
    require(all(count == 1 for count in exact_case_counts.values()),
            f"Older-dashboard visual case missing or duplicated: {exact_case_counts}")

    summary_runs = summary.get("devicesAndConfigurations", [])
    require(len(summary_runs) == 1 and summary_runs[0].get("device", {}).get("deviceId") == simulator,
            "xcresult used an unexpected simulator or test configuration")
    configuration = summary_runs[0].get("testPlanConfiguration", {}).get("configurationId")
    require(isinstance(configuration, str) and configuration,
            "xcresult summary is missing the selected test configuration")
    devices = tests.get("devices", [])
    configurations = tests.get("testPlanConfigurations", [])
    require(len(devices) == 1 and devices[0].get("deviceId") == simulator,
            "xcresult test nodes used an unexpected simulator")
    require(len(configurations) == 1 and configurations[0].get("configurationId") == configuration,
            "xcresult test nodes used an unexpected configuration")

    return {
        "result": "Passed",
        "totalTestCount": total,
        "passedTests": summary["passedTests"],
        "failedTests": summary["failedTests"],
        "skippedTests": summary["skippedTests"],
        "expectedFailures": summary["expectedFailures"],
        "simulatorId": simulator,
        "suiteCounts": dict(sorted(suite_counts.items())),
        "requiredCaseCounts": dict(sorted(exact_case_counts.items())),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate Cloudflare/ingress XCTest coverage from one pinned simulator run.")
    parser.add_argument("--result-bundle", required=True, type=Path)
    parser.add_argument("--simulator", required=True)
    parser.add_argument("--source-root", type=Path, default=Path.cwd())
    args = parser.parse_args()

    source_root = args.source_root.resolve(strict=True)
    source, inputs = source_receipt(source_root)
    receipt = verify(args.result_bundle.resolve(strict=True), args.simulator)
    receipt.update({"sourceSha": source, "inputSha256": inputs})
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Cloudflare native xcresult verification failed: {error}", file=sys.stderr)
        sys.exit(1)
