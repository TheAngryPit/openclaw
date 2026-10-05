import Foundation
import Testing
import Darwin
@testable import OpenClaw

private struct RealDistributionFileIdentity: Decodable, Equatable {
    let device: String
    let inode: String

    var receipt: [String: String] {
        ["device": self.device, "inode": self.inode]
    }
}

private struct RealDistributionManifest: Decodable {
    struct Package: Decodable {
        let name: String
        let version: String
        let integrity: String
    }

    struct Toolchain: Decodable {
        struct NodeTool: Decodable {
            let path: String
            let version: String
            let fileIdentity: RealDistributionFileIdentity
        }

        struct Tool: Decodable {
            let path: String
            let version: String
        }

        let node: NodeTool
        let npm: Tool
    }

    let schemaVersion: Int
    let runId: String
    let productSha: String
    let package: Package
    let toolchain: Toolchain
    let receiptDirectory: String
    let helperRelativePath: String
}

private enum RealDistributionTestError: Error, CustomStringConvertible {
    case invalid(String)
    case process(String)

    var description: String {
        switch self {
        case .invalid(let message), .process(let message): message
        }
    }
}

@Suite(.serialized)
@MainActor
struct CLIInstallerRealDistributionProofTests {
    private let expectedVersion = "2026.9.8"
    private let expectedIntegrity =
        "sha512-G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q=="
    private let validatedExecutableKey = cliValidatedExecutableKey
    private let validatedVersionKey = cliValidatedVersionKey
    private let installPolicyKey = cliInstallPolicyKey
    private let projectRootKey = "openclaw.gatewayProjectRootPath"

    @Test
    func `real npm managed inspection preserves CLI identity in both selection states`() async throws {
        let repoRoot = try self.productRoot()
        let manifestURL = repoRoot
            .appendingPathComponent("qa/maccli-real-distribution-qa-20261005/manifest.json")
        let manifestData = try Data(contentsOf: manifestURL)
        let manifest = try JSONDecoder().decode(RealDistributionManifest.self, from: manifestData)
        try self.validate(manifest: manifest)

        guard let ci = getenv("CI"), String(cString: ci) == "true" else {
            throw RealDistributionTestError.invalid("The canonical native launcher did not preserve CI=true.")
        }
        guard let homeValue = getenv("HOME"), let fixedHomeValue = getenv("CFFIXED_USER_HOME"),
              let tempValue = getenv("TMPDIR"), let profileValue = getenv("OPENCLAW_PROFILE"),
              String(cString: profileValue) == "default"
        else {
            throw RealDistributionTestError.invalid("The canonical native launcher did not provide its isolated HOME, TMPDIR, and default profile.")
        }
        let rawHome = String(cString: homeValue)
        let rawFixedHome = String(cString: fixedHomeValue)
        let rawTemporaryDirectory = String(cString: tempValue)
        let home = URL(fileURLWithPath: rawHome, isDirectory: true).standardizedFileURL
        let fixedHome = URL(fileURLWithPath: rawFixedHome, isDirectory: true).standardizedFileURL
        let foundationHome = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL
        let homePathEvidence: [String: Any] = [
            "launcherHomeEnvironment": rawHome,
            "launcherFixedUserHomeEnvironment": rawFixedHome,
            "foundationHome": foundationHome.path,
            "canonicalLauncherHome": self.canonicalPath(home).map { $0 as Any } ?? NSNull(),
            "canonicalFixedUserHome": self.canonicalPath(fixedHome).map { $0 as Any } ?? NSNull(),
            "canonicalFoundationHome": self.canonicalPath(foundationHome).map { $0 as Any } ?? NSNull(),
        ]
        guard self.canonicalPath(home) == self.canonicalPath(fixedHome),
              self.canonicalPath(home) == self.canonicalPath(foundationHome)
        else {
            throw RealDistributionTestError.invalid("Foundation's home does not resolve to the launcher's disposable HOME: \(homePathEvidence)")
        }
        let temporaryDirectory = URL(fileURLWithPath: rawTemporaryDirectory, isDirectory: true).standardizedFileURL
        let receiptDirectory = URL(fileURLWithPath: manifest.receiptDirectory, isDirectory: true).standardizedFileURL
        guard !self.isWithin(home, receiptDirectory), self.isWithin(temporaryDirectory, receiptDirectory) == false else {
            throw RealDistributionTestError.invalid("Persistent receipts must remain outside the launcher HOME and temporary cleanup tree.")
        }

        // Derive the managed install tree from the same production APIs under the launcher's real HOME/profile.
        let managedPrefixPath = CLIInstaller.installPrefix()
        let managedExecutablePath = CLIInstaller.managedExecutableLocation()
        let managedPrefix = URL(fileURLWithPath: managedPrefixPath, isDirectory: true)
        let managedExecutable = URL(fileURLWithPath: managedExecutablePath)
        guard self.isStrictlyWithin(home, managedPrefix),
              self.isStrictlyWithin(managedPrefix, managedExecutable)
        else {
            let evidence: [String: Any] = [
                "launcherHomeEnvironment": rawHome,
                "launcherFixedUserHomeEnvironment": rawFixedHome,
                "foundationHome": foundationHome.path,
                "managedPrefixFromCLIInstaller": managedPrefixPath,
                "managedExecutableFromCLIInstaller": managedExecutablePath,
                "canonicalHome": self.canonicalPath(home).map { $0 as Any } ?? NSNull(),
                "canonicalManagedPrefix": self.canonicalPath(managedPrefix).map { $0 as Any } ?? NSNull(),
                "canonicalManagedExecutable": self.canonicalPath(managedExecutable).map { $0 as Any } ?? NSNull(),
            ]
            throw RealDistributionTestError.invalid("The runtime-derived managed install paths are not safely beneath the disposable HOME: \(evidence)")
        }
        guard !FileManager.default.fileExists(atPath: managedPrefix.path) else {
            throw RealDistributionTestError.invalid("Refusing to overwrite a pre-existing managed prefix in the disposable HOME.")
        }

        let tempRoot = temporaryDirectory.appendingPathComponent(
            "maccli-real-distribution-\(manifest.runId)",
            isDirectory: true,
        )
        guard !FileManager.default.fileExists(atPath: tempRoot.path) else {
            throw RealDistributionTestError.invalid("The unique per-run temporary test root already exists.")
        }
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: false)
        let externalPrefix = tempRoot.appendingPathComponent("external-npm-prefix", isDirectory: true)
        let projectRoot = tempRoot.appendingPathComponent("empty-project-root", isDirectory: true)
        let configPath = tempRoot.appendingPathComponent("openclaw-test-config.json")
        try FileManager.default.createDirectory(at: projectRoot, withIntermediateDirectories: false)
        try Data("{}\n".utf8).write(to: configPath, options: .atomic)

        let previousEnvironment = self.environmentSnapshot(keys: [
            "OPENCLAW_CONFIG_PATH",
            "OPENCLAW_STATE_DIR",
        ])
        let previousDefaults = self.defaultsSnapshot()
        var helperInstallSucceeded = false
        var externalCell: [String: Any]?
        var unsetCell: [String: Any]?
        var testFailure: Error?

        do {
            try await TestIsolation.withIsolatedState(
                env: [
                    "OPENCLAW_CONFIG_PATH": configPath.path,
                ],
                defaults: [
                    self.validatedExecutableKey: externalPrefix.appendingPathComponent("bin/openclaw").path,
                    self.validatedVersionKey: self.expectedVersion,
                    self.installPolicyKey: nil,
                    self.projectRootKey: projectRoot.path,
                ]
            ) {
                let actualHome = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL
                guard self.canonicalPath(actualHome) == self.canonicalPath(home) else {
                    throw RealDistributionTestError.invalid("TestIsolation changed the launcher HOME unexpectedly: \(homePathEvidence)")
                }

                try self.runInstallHelper(
                    manifest: manifest,
                    repoRoot: repoRoot,
                    swiftHome: foundationHome,
                    managedPrefix: managedPrefixPath,
                    managedExecutable: managedExecutablePath,
                    externalPrefix: externalPrefix,
                )
                helperInstallSucceeded = true

                let externalExecutable = externalPrefix.appendingPathComponent("bin/openclaw").standardizedFileURL
                guard let externalCanonicalPath = self.canonicalPath(externalExecutable),
                      let managedCanonicalPath = self.canonicalPath(managedExecutable)
                else {
                    throw RealDistributionTestError.invalid("Could not resolve both installed CLI executable paths after helper installation.")
                }
                let externalResolved = URL(fileURLWithPath: externalCanonicalPath)
                let managedResolved = URL(fileURLWithPath: managedCanonicalPath)
                let externalExecutableIdentity = try self.fileIdentity(at: externalResolved.path)
                let managedExecutableIdentity = try self.fileIdentity(at: managedResolved.path)
                let pinnedNodeIdentity = try self.fileIdentity(at: manifest.toolchain.node.path)
                guard pinnedNodeIdentity == manifest.toolchain.node.fileIdentity else {
                    throw RealDistributionTestError.invalid("The manifest's pinned Node filesystem identity changed before the proof cells.")
                }
                let selectedBeforeDiscovery = AppDefaults.standard.string(forKey: self.validatedExecutableKey)
                let versionBeforeDiscovery = AppDefaults.standard.string(forKey: self.validatedVersionKey)
                let discovered = await CLIInstaller.status()
                let discoveredReady: Bool
                if case let .ready(location, version) = discovered {
                    discoveredReady = location == externalExecutable.path && version == self.expectedVersion
                } else {
                    discoveredReady = false
                }
                let statusRuntime = await self.resolvedRuntimePaths(for: externalExecutable.path)
                let managedRuntime = await self.resolvedRuntimePaths(for: managedExecutablePath)
                guard let statusRuntimeFinalPath = statusRuntime.finalPath,
                      let managedRuntimeFinalPath = managedRuntime.finalPath
                else {
                    throw RealDistributionTestError.invalid("RuntimeLocator did not resolve the pinned Node for both CLI paths.")
                }
                let statusRuntimeIdentity = try self.fileIdentity(at: statusRuntimeFinalPath)
                let managedRuntimeIdentity = try self.fileIdentity(at: managedRuntimeFinalPath)

                let inspected = await CLIInstaller.managedStatus(
                    expectedVersion: self.expectedVersion,
                    usesBundledRuntime: false,
                )
                let managedReady: Bool
                if case let .ready(location, version) = inspected {
                    managedReady = location == managedExecutablePath && version == self.expectedVersion
                } else {
                    managedReady = false
                }
                let selectedAfterInspection = AppDefaults.standard.string(forKey: self.validatedExecutableKey)
                let versionAfterInspection = AppDefaults.standard.string(forKey: self.validatedVersionKey)
                let resolvedCommand = CommandResolver.openclawExecutable()
                let resolvedCommandFinalPath = resolvedCommand.map {
                    self.canonicalPath(URL(fileURLWithPath: $0)) ?? ""
                }
                let checks: [String: Bool] = [
                    "isolatedRunnerHome": self.canonicalPath(actualHome) == self.canonicalPath(home),
                    "managedPathMatchesRuntimeDerivation": managedPrefixPath == CLIInstaller.installPrefix()
                        && managedExecutablePath == CLIInstaller.managedExecutableLocation(),
                    "distinctInstallations": externalExecutable.path != managedExecutablePath
                        && externalExecutableIdentity != managedExecutableIdentity,
                    "externalCLIReady": discoveredReady,
                    "runtimeNodeSearchPathIsPinned": statusRuntime.rawPath == externalPrefix.appendingPathComponent("bin/node").path
                        && statusRuntimeIdentity == pinnedNodeIdentity,
                    "managedRuntimeSearchPathIsPinned": managedRuntime.rawPath == managedPrefix.appendingPathComponent("bin/node").path
                        && managedRuntimeIdentity == pinnedNodeIdentity,
                    "managedCLIReady": managedReady,
                    "externalSelectionSeeded": selectedBeforeDiscovery == externalExecutable.path
                        && versionBeforeDiscovery == self.expectedVersion,
                    "selectedExecutablePreserved": selectedAfterInspection == externalExecutable.path,
                    "selectedVersionPreserved": versionAfterInspection == self.expectedVersion,
                    "resolverSelectsExternal": resolvedCommand == externalExecutable.path,
                    "resolverFinalPathIsExternal": resolvedCommandFinalPath == externalResolved.path,
                ]
                let overwroteExternal = selectedAfterInspection == managedExecutablePath
                    && versionAfterInspection == self.expectedVersion
                    && resolvedCommand == managedExecutablePath
                    && resolvedCommandFinalPath == managedResolved.path
                let externalReceipt: [String: Any] = [
                    "schemaVersion": 1,
                    "runId": manifest.runId,
                    "productSha": manifest.productSha,
                    "cell": "external-selected",
                    "bodyCompleted": true,
                    "checks": checks,
                    "observedRegression": ["managedInspectionOverwroteExternalSelection": overwroteExternal],
                    "packageVersion": self.expectedVersion,
                    "integrity": manifest.package.integrity,
                    "node": ["path": manifest.toolchain.node.path, "version": manifest.toolchain.node.version],
                    "npm": ["path": manifest.toolchain.npm.path, "version": manifest.toolchain.npm.version],
                    "home": home.path,
                    "launcherHomeEnvironment": rawHome,
                    "launcherFixedUserHomeEnvironment": rawFixedHome,
                    "foundationHome": foundationHome.path,
                    "canonicalHome": self.canonicalPath(home).map { $0 as Any } ?? NSNull(),
                    "stateDirectory": self.environmentValue("OPENCLAW_STATE_DIR"),
                    "managedPrefix": managedPrefixPath,
                    "managedExecutable": managedExecutablePath,
                    "managedResolvedExecutable": managedResolved.path,
                    "managedResolvedExecutableIdentity": managedExecutableIdentity.receipt,
                    "externalPrefix": externalPrefix.path,
                    "externalExecutable": externalExecutable.path,
                    "externalResolvedExecutable": externalResolved.path,
                    "externalResolvedExecutableIdentity": externalExecutableIdentity.receipt,
                    "runtimeNodePath": statusRuntime.rawPath.map { $0 as Any } ?? NSNull(),
                    "runtimeNodeFinalPath": statusRuntime.finalPath.map { $0 as Any } ?? NSNull(),
                    "runtimeNodeFileIdentity": statusRuntimeIdentity.receipt,
                    "managedRuntimeNodePath": managedRuntime.rawPath.map { $0 as Any } ?? NSNull(),
                    "managedRuntimeNodeFinalPath": managedRuntime.finalPath.map { $0 as Any } ?? NSNull(),
                    "managedRuntimeNodeFileIdentity": managedRuntimeIdentity.receipt,
                    "discoveryStatus": String(describing: discovered),
                    "managedStatus": String(describing: inspected),
                    "selectedExecutableBeforeDiscovery": selectedBeforeDiscovery.map { $0 as Any } ?? NSNull(),
                    "selectedVersionBeforeDiscovery": versionBeforeDiscovery.map { $0 as Any } ?? NSNull(),
                    "selectedExecutableAfterInspection": selectedAfterInspection.map { $0 as Any } ?? NSNull(),
                    "selectedVersionAfterInspection": versionAfterInspection.map { $0 as Any } ?? NSNull(),
                    "resolverExecutable": resolvedCommand.map { $0 as Any } ?? NSNull(),
                    "resolverFinalPath": resolvedCommandFinalPath.map { $0 as Any } ?? NSNull(),
                ]
                externalCell = externalReceipt
                try self.writeReceipt(externalReceipt, to: receiptDirectory.appendingPathComponent("cell-external-selected.json"))

                AppDefaults.standard.removeObject(forKey: self.validatedExecutableKey)
                AppDefaults.standard.removeObject(forKey: self.validatedVersionKey)
                let executableInitiallyUnset = AppDefaults.standard.string(forKey: self.validatedExecutableKey) == nil
                let versionInitiallyUnset = AppDefaults.standard.string(forKey: self.validatedVersionKey) == nil
                let unsetManagedRuntime = await self.resolvedRuntimePaths(for: managedExecutablePath)
                guard let unsetRuntimeFinalPath = unsetManagedRuntime.finalPath else {
                    throw RealDistributionTestError.invalid("RuntimeLocator did not resolve the pinned Node for the initially-unset cell.")
                }
                let unsetRuntimeIdentity = try self.fileIdentity(at: unsetRuntimeFinalPath)
                let unsetManagedStatus = await CLIInstaller.managedStatus(
                    expectedVersion: self.expectedVersion,
                    usesBundledRuntime: false,
                )
                let unsetManagedReady: Bool
                if case let .ready(location, version) = unsetManagedStatus {
                    unsetManagedReady = location == managedExecutablePath && version == self.expectedVersion
                } else {
                    unsetManagedReady = false
                }
                let executableRemainsUnset = AppDefaults.standard.string(forKey: self.validatedExecutableKey) == nil
                let versionRemainsUnset = AppDefaults.standard.string(forKey: self.validatedVersionKey) == nil
                let unsetExecutableAfter = AppDefaults.standard.string(forKey: self.validatedExecutableKey)
                let unsetVersionAfter = AppDefaults.standard.string(forKey: self.validatedVersionKey)
                let selectedWhenUnset = unsetExecutableAfter == managedExecutablePath
                    && unsetVersionAfter == self.expectedVersion
                let unsetChecks: [String: Bool] = [
                    "isolatedRunnerHome": self.canonicalPath(actualHome) == self.canonicalPath(home),
                    "managedPathMatchesRuntimeDerivation": managedPrefixPath == CLIInstaller.installPrefix()
                        && managedExecutablePath == CLIInstaller.managedExecutableLocation(),
                    "runtimeNodeSearchPathIsPinned": unsetManagedRuntime.rawPath == managedPrefix.appendingPathComponent("bin/node").path
                        && unsetRuntimeIdentity == pinnedNodeIdentity,
                    "managedCLIReady": unsetManagedReady,
                    "validatedExecutableInitiallyUnset": executableInitiallyUnset,
                    "validatedVersionInitiallyUnset": versionInitiallyUnset,
                    "validatedExecutableRemainsUnset": executableRemainsUnset,
                    "validatedVersionRemainsUnset": versionRemainsUnset,
                ]
                let unsetReceipt: [String: Any] = [
                    "schemaVersion": 1,
                    "runId": manifest.runId,
                    "productSha": manifest.productSha,
                    "cell": "initially-unset",
                    "bodyCompleted": true,
                    "checks": unsetChecks,
                    "observedRegression": ["managedInspectionSelectedCLIWhenInitiallyUnset": selectedWhenUnset],
                    "packageVersion": self.expectedVersion,
                    "integrity": manifest.package.integrity,
                    "home": home.path,
                    "launcherHomeEnvironment": rawHome,
                    "launcherFixedUserHomeEnvironment": rawFixedHome,
                    "foundationHome": foundationHome.path,
                    "canonicalHome": self.canonicalPath(home).map { $0 as Any } ?? NSNull(),
                    "stateDirectory": self.environmentValue("OPENCLAW_STATE_DIR"),
                    "managedPrefix": managedPrefixPath,
                    "managedExecutable": managedExecutablePath,
                    "managedStatus": String(describing: unsetManagedStatus),
                    "runtimeNodePath": unsetManagedRuntime.rawPath.map { $0 as Any } ?? NSNull(),
                    "runtimeNodeFinalPath": unsetManagedRuntime.finalPath.map { $0 as Any } ?? NSNull(),
                    "runtimeNodeFileIdentity": unsetRuntimeIdentity.receipt,
                    "validatedExecutableInitiallyUnset": executableInitiallyUnset,
                    "validatedVersionInitiallyUnset": versionInitiallyUnset,
                    "validatedExecutableAfterInspection": unsetExecutableAfter.map { $0 as Any } ?? NSNull(),
                    "validatedVersionAfterInspection": unsetVersionAfter.map { $0 as Any } ?? NSNull(),
                ]
                unsetCell = unsetReceipt
                try self.writeReceipt(unsetReceipt, to: receiptDirectory.appendingPathComponent("cell-initially-unset.json"))

                #expect(checks["isolatedRunnerHome"] == true)
                #expect(checks["managedPathMatchesRuntimeDerivation"] == true)
                #expect(checks["distinctInstallations"] == true)
                #expect(checks["externalCLIReady"] == true)
                #expect(checks["runtimeNodeSearchPathIsPinned"] == true)
                #expect(checks["managedRuntimeSearchPathIsPinned"] == true)
                #expect(checks["managedCLIReady"] == true)
                #expect(checks["externalSelectionSeeded"] == true)
                #expect(checks["selectedExecutablePreserved"] == true)
                #expect(checks["selectedVersionPreserved"] == true)
                #expect(checks["resolverSelectsExternal"] == true)
                #expect(checks["resolverFinalPathIsExternal"] == true)
                #expect(unsetChecks["isolatedRunnerHome"] == true)
                #expect(unsetChecks["managedPathMatchesRuntimeDerivation"] == true)
                #expect(unsetChecks["runtimeNodeSearchPathIsPinned"] == true)
                #expect(unsetChecks["managedCLIReady"] == true)
                #expect(unsetChecks["validatedExecutableInitiallyUnset"] == true)
                #expect(unsetChecks["validatedVersionInitiallyUnset"] == true)
                #expect(unsetChecks["validatedExecutableRemainsUnset"] == true)
                #expect(unsetChecks["validatedVersionRemainsUnset"] == true)
            }
        } catch {
            testFailure = error
        }

        let managedPrefixRemoved: Bool
        do {
            if FileManager.default.fileExists(atPath: managedPrefix.path) {
                guard self.isStrictlyWithin(home, managedPrefix) else {
                    throw RealDistributionTestError.invalid("Refusing to clean a managed prefix outside the isolated HOME.")
                }
                try FileManager.default.removeItem(at: managedPrefix)
            }
            managedPrefixRemoved = !FileManager.default.fileExists(atPath: managedPrefix.path)
        } catch {
            managedPrefixRemoved = false
            if testFailure == nil { testFailure = error }
        }
        let tempRootRemoved: Bool
        do {
            if FileManager.default.fileExists(atPath: tempRoot.path) {
                guard self.isStrictlyWithin(temporaryDirectory, tempRoot) else {
                    throw RealDistributionTestError.invalid("Refusing to clean a temporary root outside launcher TMPDIR.")
                }
                try FileManager.default.removeItem(at: tempRoot)
            }
            tempRootRemoved = !FileManager.default.fileExists(atPath: tempRoot.path)
        } catch {
            tempRootRemoved = false
            if testFailure == nil { testFailure = error }
        }
        let defaultsRestored = self.defaultsSnapshot() == previousDefaults
        let environmentRestored = self.environmentSnapshot(keys: previousEnvironment.keys) == previousEnvironment
        let cleanupReceipt: [String: Any] = [
            "schemaVersion": 1,
            "runId": manifest.runId,
            "productSha": manifest.productSha,
            "bodyCompleted": externalCell != nil && unsetCell != nil,
            "helperInstallSucceeded": helperInstallSucceeded,
            "managedPrefix": managedPrefixPath,
            "managedPrefixRemoved": managedPrefixRemoved,
            "launcherHomeEnvironment": rawHome,
            "launcherFixedUserHomeEnvironment": rawFixedHome,
            "foundationHome": foundationHome.path,
            "canonicalHome": self.canonicalPath(home).map { $0 as Any } ?? NSNull(),
            "canonicalManagedPrefix": self.canonicalPath(managedPrefix).map { $0 as Any } ?? NSNull(),
            "tempRoot": tempRoot.path,
            "tempRootRemoved": tempRootRemoved,
            "testIsolationDefaultsRestored": defaultsRestored,
            "testIsolationEnvRestored": environmentRestored,
            "cleanupComplete": managedPrefixRemoved && tempRootRemoved && defaultsRestored && environmentRestored,
            "failure": testFailure.map { String(describing: $0) as Any } ?? NSNull(),
        ]
        try self.writeReceipt(cleanupReceipt, to: receiptDirectory.appendingPathComponent("cleanup-receipt.json"))

        #expect(managedPrefixRemoved)
        #expect(tempRootRemoved)
        #expect(defaultsRestored)
        #expect(environmentRestored)
        if let testFailure { throw testFailure }
    }

    private func productRoot() throws -> URL {
        var root = URL(fileURLWithPath: #filePath).standardizedFileURL
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let manifest = root.appendingPathComponent("qa/maccli-real-distribution-qa-20261005/manifest.json")
        guard FileManager.default.fileExists(atPath: manifest.path) else {
            throw RealDistributionTestError.invalid("Could not locate the staged immutable real-distribution manifest from #filePath.")
        }
        return root
    }

    private func validate(manifest: RealDistributionManifest) throws {
        let allowedRevisions = [
            "3b16db73c0b5209aad2ee7c3fb5ddfb12fb208f9",
            "a38ed66158bd270bd45607411aadb5862b299b8b",
        ]
        guard manifest.schemaVersion == 1,
              allowedRevisions.contains(manifest.productSha),
              manifest.package.name == "openclaw",
              manifest.package.version == self.expectedVersion,
              manifest.package.integrity == self.expectedIntegrity,
              manifest.toolchain.node.version == "v24.19.0",
              manifest.toolchain.npm.version == "11.17.0",
              FileManager.default.isExecutableFile(atPath: manifest.toolchain.node.path)
        else {
            throw RealDistributionTestError.invalid("Manifest release, source revision, or toolchain did not match the pinned QA inputs.")
        }
        let receipts = URL(fileURLWithPath: manifest.receiptDirectory, isDirectory: true)
        guard receipts.path.hasPrefix("/") else {
            throw RealDistributionTestError.invalid("Manifest receipt directory is not absolute.")
        }
    }

    private func runInstallHelper(
        manifest: RealDistributionManifest,
        repoRoot: URL,
        swiftHome: URL,
        managedPrefix: String,
        managedExecutable: String,
        externalPrefix: URL
    ) throws {
        let helper = repoRoot.appendingPathComponent(manifest.helperRelativePath)
        guard FileManager.default.isReadableFile(atPath: helper.path) else {
            throw RealDistributionTestError.invalid("Staged install helper is missing.")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: manifest.toolchain.node.path)
        process.arguments = [
            helper.path,
            "install",
            "--manifest", repoRoot.appendingPathComponent("qa/maccli-real-distribution-qa-20261005/manifest.json").path,
            "--receipt-dir", manifest.receiptDirectory,
            "--swift-home", swiftHome.path,
            "--managed-prefix", managedPrefix,
            "--managed-executable", managedExecutable,
            "--external-prefix", externalPrefix.path,
        ]
        process.currentDirectoryURL = repoRoot
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        try process.run()
        process.waitUntilExit()
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw RealDistributionTestError.process("Real npm installation helper failed with status \(process.terminationStatus).")
        }
    }

    private func environmentValue(_ key: String) -> Any {
        guard let value = getenv(key) else { return NSNull() }
        return String(cString: value)
    }

    private func resolvedRuntimePaths(for location: String) async -> (rawPath: String?, finalPath: String?) {
        let environment = CLIInstaller.probeEnvironment(
            location: location,
            preferredPaths: CommandResolver.preferredPaths(),
        )
        let paths = environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        guard case let .success(runtime) = await RuntimeLocator.resolve(searchPaths: paths) else {
            return (nil, nil)
        }
        let finalPath = URL(fileURLWithPath: runtime.path).resolvingSymlinksInPath().standardizedFileURL.path
        return (runtime.path, finalPath)
    }

    private func isWithin(_ parent: URL, _ child: URL) -> Bool {
        guard let parentPath = self.canonicalPath(parent), let childPath = self.canonicalPath(child) else {
            return false
        }
        return childPath == parentPath || childPath.hasPrefix(parentPath.hasSuffix("/") ? parentPath : parentPath + "/")
    }

    private func canonicalPath(_ url: URL) -> String? {
        var ancestor = url.standardizedFileURL
        var missingComponents: [String] = []
        while !FileManager.default.fileExists(atPath: ancestor.path) {
            let parent = ancestor.deletingLastPathComponent()
            guard parent.path != ancestor.path else { return nil }
            missingComponents.insert(ancestor.lastPathComponent, at: 0)
            ancestor = parent
        }
        var resolved = ancestor.resolvingSymlinksInPath().standardizedFileURL
        for component in missingComponents {
            resolved.appendPathComponent(component)
        }
        return resolved.standardizedFileURL.path
    }

    private func fileIdentity(at path: String) throws -> RealDistributionFileIdentity {
        var details = stat()
        let result = path.withCString { stat($0, &details) }
        guard result == 0 else {
            throw RealDistributionTestError.invalid("Darwin stat could not read filesystem identity for \(path), errno=\(errno).")
        }
        return RealDistributionFileIdentity(device: String(details.st_dev), inode: String(details.st_ino))
    }

    private func isStrictlyWithin(_ parent: URL, _ child: URL) -> Bool {
        parent.standardizedFileURL.path != child.standardizedFileURL.path && self.isWithin(parent, child)
    }

    private func writeReceipt(_ receipt: [String: Any], to destination: URL) throws {
        guard !FileManager.default.fileExists(atPath: destination.path) else {
            throw RealDistributionTestError.invalid("Refusing to overwrite an existing QA receipt: \(destination.lastPathComponent)")
        }
        let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed])
        try data.write(to: destination, options: .atomic)
    }

    private func environmentSnapshot(keys: some Sequence<String>) -> [String: String?] {
        var result: [String: String?] = [:]
        for key in keys {
            result.updateValue(getenv(key).map { String(cString: $0) }, forKey: key)
        }
        return result
    }

    private func defaultsSnapshot() -> [String: String?] {
        var result: [String: String?] = [:]
        for key in [self.validatedExecutableKey, self.validatedVersionKey, self.installPolicyKey, self.projectRootKey] {
            result.updateValue(AppDefaults.standard.object(forKey: key).map { String(describing: $0) }, forKey: key)
        }
        return result
    }
}
