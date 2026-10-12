import type {
  SystemChangeEntry,
  SystemChangesListResult,
  UserProfile,
  UsersSetDisplayNameResult,
} from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import "../../components/openclaw-mascot.ts";
import { channelSnapshotHasActiveChannel } from "../../lib/channels/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectChannels } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import "../../styles/custodian.css";
import { CustodianChangeHistory } from "./custodian-history.tsx";
import { custodianSessionStore, type CustodianSessionStore } from "./custodian-session-store.ts";
import { CustodianSurface } from "./custodian-surface.tsx";

type Props = { onboarding: boolean; newAgentIntent: boolean; store: CustodianSessionStore };
type History = {
  entries: SystemChangeEntry[];
  nextCursor: string | null;
  load: "idle" | "initial" | "more";
  error: string | null;
  loaded: boolean;
};
const emptyHistory = (): History => ({
  entries: [],
  nextCursor: null,
  load: "idle",
  error: null,
  loaded: false,
});

type OnboardingIdentityOwner = {
  client: GatewayBrowserClient;
  connectionRevision: number;
  gatewayUrl: string;
  recoveryScope: string | null;
  selfUserId: string | null;
  selfUserProfileId: string | null;
};
type OnboardingNameState = {
  profile: UserProfile | null;
  draft: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
  skipped: boolean;
};

function createOnboardingName(context: ApplicationContext, onboarding: () => boolean) {
  let owner: OnboardingIdentityOwner | null = null;
  let requestEpoch = 0;
  let disposed = false;
  let state: OnboardingNameState = {
    profile: null,
    draft: "",
    loading: false,
    busy: false,
    error: null,
    skipped: false,
  };
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const read = () => {
    revision();
    return state;
  };
  const update = (patch: Partial<OnboardingNameState>) => {
    state = { ...state, ...patch };
    setRevision((previous) => previous + 1);
  };
  const currentOwner = (): OnboardingIdentityOwner | null => {
    const gateway = context.gateway;
    const snapshot = gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    if (
      disposed ||
      !onboarding() ||
      !client ||
      !hasOperatorWriteAccess(snapshot.hello?.auth ?? null)
    ) {
      return null;
    }
    return {
      client,
      connectionRevision: gateway.connectionRevision,
      gatewayUrl: gateway.connection.gatewayUrl,
      recoveryScope: client.recoveryScope ?? null,
      selfUserId: snapshot.selfUser?.id ?? null,
      selfUserProfileId: snapshot.selfUser?.identity?.id ?? null,
    };
  };
  const sameOwner = (left: OnboardingIdentityOwner | null, right: OnboardingIdentityOwner | null) =>
    left === right ||
    (left !== null &&
      right !== null &&
      left.client === right.client &&
      left.connectionRevision === right.connectionRevision &&
      left.gatewayUrl === right.gatewayUrl &&
      left.recoveryScope === right.recoveryScope &&
      left.selfUserId === right.selfUserId &&
      left.selfUserProfileId === right.selfUserProfileId);
  const isCurrentOwner = (captured: OnboardingIdentityOwner) =>
    owner === captured && sameOwner(captured, currentOwner());

  async function load() {
    const captured = owner;
    if (!captured || !isCurrentOwner(captured) || state.loading) {
      return;
    }
    const epoch = ++requestEpoch;
    const isCurrent = () => isCurrentOwner(captured) && epoch === requestEpoch;
    update({ loading: true, error: null });
    try {
      const profile = await context.gateway.loadSelfProfile();
      if (isCurrent()) {
        update({ profile, draft: profile?.displayName ?? "" });
      }
    } catch (error) {
      if (isCurrent()) {
        update({ error: formatUiError(error, t("custodian.onboardingName.loadFailed")) });
      }
    } finally {
      if (isCurrent()) {
        update({ loading: false });
      }
    }
  }
  function synchronize() {
    const next = currentOwner();
    if (sameOwner(owner, next)) {
      return;
    }
    owner = next;
    requestEpoch += 1;
    update({ profile: null, draft: "", loading: false, busy: false, error: null });
    if (next) {
      void load();
    }
  }
  const stop = context.gateway.subscribe(synchronize);
  createEffect(onboarding, synchronize);
  onCleanup(() => {
    disposed = true;
    owner = null;
    requestEpoch += 1;
    stop();
  });

  async function save() {
    const captured = owner;
    const profile = state.profile;
    const name = state.draft.trim();
    if (!captured || !profile || !name || state.busy || !isCurrentOwner(captured)) {
      return;
    }
    const selfUserAtSaveStart = context.gateway.snapshot.selfUser;
    const epoch = requestEpoch;
    const isCurrentRequest = () => isCurrentOwner(captured) && epoch === requestEpoch;
    const isCurrent = () => isCurrentRequest() && state.profile === profile;
    update({ busy: true, error: null });
    try {
      const result = await captured.client.request<UsersSetDisplayNameResult>(
        "users.setDisplayName",
        {
          profileId: profile.id,
          displayName: name,
          onlyIfUnset: true,
        },
      );
      if (!isCurrent()) {
        return;
      }
      const currentSelfUser = context.gateway.snapshot.selfUser;
      const hasNewerDisplayName =
        currentSelfUser?.id === profile.id && currentSelfUser.name !== selfUserAtSaveStart?.name;
      const savedProfile = hasNewerDisplayName
        ? { ...result.profile, displayName: currentSelfUser.name ?? null }
        : result.profile;
      update({ profile: savedProfile, draft: savedProfile.displayName ?? "" });
      if (!hasNewerDisplayName) {
        context.gateway.updateSelfUser?.({ name: result.profile.displayName ?? undefined });
      }
    } catch (error) {
      if (isCurrent()) {
        update({ error: formatUiError(error, t("custodian.onboardingName.saveFailed")) });
      }
    } finally {
      if (isCurrentRequest()) {
        update({ busy: false });
      }
    }
  }
  return {
    read,
    load,
    save,
    setDraft: (draft: string) => update({ draft, error: null }),
    skip: () => update({ skipped: true }),
    visible: () => {
      const value = read();
      return (
        owner !== null &&
        isCurrentOwner(owner) &&
        !value.skipped &&
        (value.profile ? !value.profile.displayName?.trim() : value.error !== null)
      );
    },
  };
}

function OnboardingNamePrompt(props: { name: ReturnType<typeof createOnboardingName> }) {
  return (
    <Show when={props.name.visible()}>
      <section
        class="custodian__name-prompt custodian__column"
        aria-labelledby={props.name.read().profile ? "custodian-name-title" : undefined}
      >
        <Show
          when={props.name.read().profile}
          fallback={
            <p class="custodian__error" role="alert">
              <span>{props.name.read().error}</span>
              <button
                class="btn btn--sm"
                type="button"
                disabled={props.name.read().loading}
                onClick={() => void props.name.load()}
              >
                {props.name.read().loading ? t("common.loading") : t("common.retry")}
              </button>
            </p>
          }
        >
          <div>
            <h2 id="custodian-name-title">{t("custodian.onboardingName.title")}</h2>
            <p id="custodian-name-description">{t("custodian.onboardingName.description")}</p>
          </div>
          <form
            class="custodian__name-form"
            aria-busy={props.name.read().busy ? "true" : "false"}
            onSubmit={(event) => {
              event.preventDefault();
              void props.name.save();
            }}
          >
            <label for="custodian-onboarding-display-name">
              {t("custodian.onboardingName.label")}
            </label>
            <input
              id="custodian-onboarding-display-name"
              class="settings-input"
              type="text"
              maxLength={256}
              autocomplete="nickname"
              aria-describedby={`custodian-name-description${props.name.read().error ? " custodian-name-error" : ""}`}
              prop:value={props.name.read().draft}
              disabled={props.name.read().busy}
              onInput={(event) => props.name.setDraft(event.currentTarget.value)}
            />
            <Show when={props.name.read().error}>
              <p id="custodian-name-error" class="custodian__name-error" role="alert">
                {props.name.read().error}
              </p>
            </Show>
            <div class="custodian__name-actions">
              <button
                class="btn btn--ghost"
                type="button"
                disabled={props.name.read().busy}
                onClick={() => props.name.skip()}
              >
                {t("custodian.onboardingName.skip")}
              </button>
              <button
                class="btn"
                type="submit"
                disabled={props.name.read().busy || !props.name.read().draft.trim()}
              >
                {props.name.read().busy ? t("common.saving") : t("custodian.onboardingName.save")}
              </button>
            </div>
          </form>
        </Show>
      </section>
    </Show>
  );
}

function CustodianPageContent(props: Props) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const onboardingName = createOnboardingName(context, () => props.onboarding);
  const channels = projectChannels(context.channels);
  const store = projectSource(
    untrack(() => props.store),
    {
      read: (source) => source,
      subscribe: (source, notify) => source.subscribe(notify),
      equality: "revision",
    },
  );
  createEffect(
    () => props.store,
    (source) => {
      store.replaceSource(source);
      void source.refreshTranscriptIfIdle();
    },
  );
  const historyAvailable = createMemo(() => {
    const snapshot = gateway.read().snapshot;
    return (
      snapshot.phase === "connected" &&
      snapshot.client !== null &&
      isGatewayMethodAdvertised(snapshot, "openclaw.changes.list") === true
    );
  });
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [history, setHistory] = createSignal<History>(emptyHistory());
  let historyClient: GatewayBrowserClient | null = null;
  let historyWasAvailable = false;
  let historyRequestEpoch = 0;
  let historyBusy = false;
  let disposed = false;
  createEffect(
    () => [gateway.read().snapshot.client, historyAvailable()] as const,
    ([client, available]) => {
      if (client === historyClient && available === historyWasAvailable) {
        return;
      }
      historyClient = client;
      historyWasAvailable = available;
      historyRequestEpoch += 1;
      historyBusy = false;
      setHistoryOpen(false);
      setHistory(emptyHistory());
    },
  );
  onCleanup(() => {
    disposed = true;
  });
  createEffect(
    () => [props.onboarding, store.read().channelOnboardingNudgeClosed, channels.read()] as const,
    ([onboarding, closed, state]) => {
      if (
        onboarding &&
        !closed &&
        state.connected &&
        !state.channelsSnapshot &&
        !state.channelsLoading &&
        !state.channelsError
      ) {
        void context.channels.refresh(false);
      }
    },
  );

  async function loadHistory(reset: boolean) {
    const client = historyClient;
    const cursor = reset ? undefined : (history().nextCursor ?? undefined);
    if (!client || !historyAvailable() || historyBusy || (!reset && !cursor)) {
      return;
    }
    const epoch = ++historyRequestEpoch;
    historyBusy = true;
    setHistory((previous) => ({ ...previous, load: reset ? "initial" : "more", error: null }));
    const isCurrent = () =>
      !disposed &&
      historyRequestEpoch === epoch &&
      context.gateway.snapshot.phase === "connected" &&
      context.gateway.snapshot.client === client &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.changes.list") === true;
    try {
      const result = await client.request<SystemChangesListResult>("openclaw.changes.list", {
        limit: 50,
        ...(cursor ? { beforeCursor: cursor } : {}),
      });
      if (isCurrent()) {
        setHistory((previous) => ({
          ...previous,
          entries: reset ? result.entries : [...previous.entries, ...result.entries],
          nextCursor: result.nextCursor ?? null,
        }));
      }
    } catch {
      if (isCurrent()) {
        setHistory((previous) => ({ ...previous, error: t("custodian.history.requestFailed") }));
      }
    } finally {
      if (isCurrent()) {
        historyBusy = false;
        setHistory((previous) => ({ ...previous, load: "idle", loaded: true }));
      }
    }
  }
  const channelStatusError = () =>
    props.onboarding && !store.read().channelOnboardingNudgeClosed && channels.read().connected
      ? channels.read().channelsError
      : null;
  const showChannelOnboardingNudge = () => {
    const state = channels.read();
    const snapshot = state.channelsSnapshot;
    return (
      props.onboarding &&
      !store.read().channelOnboardingNudgeClosed &&
      state.connected &&
      !state.channelsLoading &&
      channelStatusError() === null &&
      snapshot !== null &&
      snapshot.partial !== true &&
      !channelSnapshotHasActiveChannel(snapshot)
    );
  };
  return (
    <section
      class={[
        "custodian custodian--page",
        { "custodian--setup-required": store.read().setupRequired },
        { "custodian--onboarding": onboardingName.visible() },
      ]}
    >
      <header
        class={[
          "custodian__header custodian__column",
          { "custodian__header--minimal": props.onboarding },
        ]}
      >
        <Show when={!props.onboarding}>
          <div class="custodian__identity">
            <div class="custodian__mark" aria-hidden="true">
              <openclaw-mascot mood={store.read().sending ? "thinking" : "idle"} prop:size={38} />
            </div>
            <div>
              <h1>{t("custodian.title")}</h1>
              <p>{t("custodian.subtitleCaretaker")}</p>
            </div>
          </div>
        </Show>
        <div class="custodian__header-actions">
          <Show when={props.onboarding}>
            <openclaw-sidebar-attention />
          </Show>
          <Show when={historyAvailable()}>
            <button
              class="btn btn--ghost custodian__history-toggle"
              type="button"
              aria-expanded={historyOpen() ? "true" : "false"}
              onClick={() => {
                const open = !historyOpen();
                setHistoryOpen(open);
                if (open && !historyBusy) {
                  void loadHistory(true);
                }
              }}
            >
              {t("custodian.history.button")}
            </button>
          </Show>
          <Show when={props.onboarding}>
            <button class="btn btn--ghost" type="button" onClick={() => props.store.exitSetup()}>
              {t("custodian.exitSetup")}
            </button>
          </Show>
        </div>
      </header>
      <OnboardingNamePrompt name={onboardingName} />
      <CustodianSurface
        class="custodian__column"
        store={props.store}
        onboarding={props.onboarding}
        newAgentIntent={props.newAgentIntent}
        showChannelOnboardingNudge={showChannelOnboardingNudge()}
        channelOnboardingError={channelStatusError()}
        channelOnboardingRetrying={channels.read().channelsLoading}
        onRetryChannelOnboarding={() => void context.channels.refresh(false)}
        historyContent={
          <Show when={historyOpen() && historyAvailable()}>
            <CustodianChangeHistory
              entries={history().entries}
              error={history().error}
              loaded={history().loaded}
              loading={history().load === "initial"}
              loadingMore={history().load === "more"}
              nextCursor={history().nextCursor}
              onLoad={(reset) => void loadHistory(reset)}
            />
          </Show>
        }
      />
    </section>
  );
}

defineSolidBridge<Props>("openclaw-custodian-page", CustodianPageContent, {
  properties: {
    onboarding: { default: false, attribute: false },
    newAgentIntent: { default: false, attribute: false },
    store: { default: custodianSessionStore, attribute: false },
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-custodian-page": SolidBridgeElement<Props>;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sidebar-attention": HTMLAttributes<HTMLElement>;
    }
  }
}
