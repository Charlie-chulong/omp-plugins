import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Image, Pressable, Text, TextInput, View, StyleSheet } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import type { PluginClientContext, PluginSettingsPageProps, PluginStorageSnapshot } from "@omp-desktop/plugin";
import type { OmpProviderFeaturesResult, OmpProviderSnapshotResult } from "@omp-desktop/client";
import type { AgentSessionConfig } from "@omp-desktop/protocol/agent-types";
import { DEFAULT_PET_CONFIG, PetConfigSchema } from "./config.js";
import { PetHostActivityDirectory, usePetHosts, usePetTranslation } from "./client-host.js";
import type { PetConnectedHost, PetHostActivity } from "./client-host.js";
import { deriveDesktopPetTasks } from "./model.js";
import { launchDesktopPetCreation } from "./creation.js";
import { getPetAuthoringDraft } from "./authoring-draft.js";
import { petActivityRpc, petCreationContextRpc, petImportRpc, petListRpc, petPrepareCreationRpc } from "./rpc.js";
import type { DesktopPetActivity, DesktopPetSettings, PetDescriptor, PetSize } from "./types.js";
export default function setup(ctx: PluginClientContext) {
  const Settings = (props: PluginSettingsPageProps) => <DesktopPetSettingsPage {...props} context={ctx} />;
  ctx.addSettingsPage({ id: "settings", title: "Desktop pet", icon: "paw-print", Component: Settings });
  if (ctx.mode === "active") ctx.addOverlay({ id: "pet", Component: () => <DesktopPetActivitySync context={ctx} /> });
}
function usePetConfiguration(ctx: PluginClientContext) {
  const [snapshot, setSnapshot] = useState<PluginStorageSnapshot<DesktopPetSettings>>({ revision: -1, values: DEFAULT_PET_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { t } = usePetTranslation();
  const [error, setError] = useState<string | null>(null);
  const current = useRef(snapshot);
  current.current = snapshot;
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const raw = await ctx.storage.get();
      const next = { revision: raw.revision, values: PetConfigSchema.parse(raw.values) };
      if (!disposed && next.revision >= current.current.revision) { current.current = next; setSnapshot(next); setError(null); }
    };
    const reportError = (error: unknown) => { if (!disposed) setError(`${t("desktop.settings.loadFailed")} ${error instanceof Error ? error.message : String(error)}`); };
    const remove = ctx.native.subscribe("plugins:changed", () => { void load().catch(reportError); });
    void load().catch(reportError).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; void remove(); };
  }, [ctx, t]);
  const patch = async (values: Partial<DesktopPetSettings>) => {
    setSaving(true);
    try { const raw = await ctx.storage.patch(values, current.current.revision); const next = { revision: raw.revision, values: PetConfigSchema.parse(raw.values) }; current.current = next; setSnapshot(next); setError(null); }
    catch (error) { setError(`${t("desktop.settings.saveFailed")} ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSaving(false); }
  };
  return { config: snapshot.values, loading: loading || snapshot.revision < 0, saving, patch, error };
}
function DesktopPetSettingsPage({ context: ctx, theme }: PluginSettingsPageProps & { context: PluginClientContext }) {
  const { t } = usePetTranslation();
  const { config, loading, saving, patch, error } = usePetConfiguration(ctx);
  const [message, setMessage] = useState<string | null>(null);
  const [pets, setPets] = useState<PetDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = async () => { setBusy(true); try { setPets(await ctx.rpc(petListRpc, {})); setLoadError(null); } catch (error) { setLoadError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  useEffect(() => { void refresh(); }, [ctx]);
  const disabled = loading || saving || busy;
  const importPet = async () => {
    setBusy(true);
    try {
      const directory = await ctx.native.invoke<string | null>("dialog.open", { title: t("desktop.pets.importTitle"), directory: true, multiple: false });
      if (!directory) return;
      await ctx.rpc(petImportRpc, { directory });
      setPets(await ctx.rpc(petListRpc, {}));
      setMessage(t("desktop.pets.imported"));
    } catch (error) { setLoadError(t("desktop.pets.importFailed", { message: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); }
  };
  return <View style={[styles.page, { backgroundColor: theme.colors.surface0 }]}>
    <View style={styles.row}><Text style={[styles.title, { color: theme.colors.foreground }]}>{t("desktop.pets.size")}</Text><View style={styles.actions}>{(["small", "medium", "large"] as PetSize[]).map((size) => <Action key={size} title={t(`desktop.pets.sizes.${size}`)} selected={config.size === size} disabled={disabled} onPress={() => { void patch({ size }); }} color={theme.colors.foreground} accent={theme.colors.accent} />)}</View></View>
    {error || loadError ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error ?? loadError}</Text> : null}
    {message ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foreground }}>{message}</Text> : null}
    <View style={styles.gallery}>{pets.map((pet) => <Pressable key={pet.id} disabled={disabled} onPress={() => { void patch({ selectedId: pet.id }); }} accessibilityRole="button" accessibilityLabel={t("desktop.pets.selectPet", { name: pet.name })} accessibilityState={{ selected: config.selectedId === pet.id, disabled }} style={[styles.petCard, { borderColor: config.selectedId === pet.id ? theme.colors.accent : theme.colors.foregroundMuted }]}>
      <Image source={{ uri: pet.previewUrl }} resizeMode="contain" accessibilityIgnoresInvertColors style={styles.preview} />
      <Text style={[styles.title, { color: theme.colors.foreground }]}>{pet.name}</Text><Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted }}>{pet.description}</Text><Text style={{ color: theme.colors.foregroundMuted }}>{t(config.selectedId === pet.id ? "desktop.pets.selected" : pet.builtIn ? "desktop.pets.builtIn" : "desktop.pets.custom")}</Text>
    </Pressable>)}</View>
    <View style={styles.actions}><Action title={t(busy ? "desktop.pets.importing" : "desktop.pets.import")} disabled={disabled} onPress={() => { void importPet(); }} color={theme.colors.foreground} accent={theme.colors.accent} /><Action title={t("desktop.pets.refresh")} disabled={disabled} onPress={() => { void refresh(); }} color={theme.colors.foreground} accent={theme.colors.accent} /></View>
    <PetCreator context={ctx} disabled={disabled} theme={theme} />
  </View>;
}
function Action({ title, selected = false, disabled, onPress, color, accent }: { title: string; selected?: boolean; disabled: boolean; onPress(): void; color: string; accent: string }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.button, { borderColor: selected ? accent : color, opacity: disabled ? 0.45 : 1 }]}><Text style={{ color: selected ? accent : color }}>{title}</Text></Pressable>;
}
type PetPreferences = Omit<AgentSessionConfig, "cwd">;
type PetProvider = OmpProviderSnapshotResult["entries"][number];
const MODE_LABEL_KEYS: Record<string, string> = { ask: "alwaysAsk", full: "fullAccess", auto: "autoApproval", default: "default", plan: "plan", acceptEdits: "acceptEdits", bypassPermissions: "bypassPermissions", build: "build" };
function usePetCreationDraft(ctx: PluginClientContext, initialPreferences: PetPreferences | null) {
  const { t } = usePetTranslation();
  const hosts = usePetHosts(ctx);
  const canRead = ctx.installation.declaredCapabilities.includes("agents.events") && ctx.installation.grantedCapabilities.includes("agents.events");
  const canCreate = ctx.installation.declaredCapabilities.includes("agents.create") && ctx.installation.grantedCapabilities.includes("agents.create");
  const [localHosts, setLocalHosts] = useState<readonly PetConnectedHost[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<PetPreferences>(initialPreferences ?? { provider: "omp" });
  const [provider, setProvider] = useState<PetProvider | null>(null);
  const [features, setFeatures] = useState<NonNullable<OmpProviderFeaturesResult["features"]>>([]);
  const [cwd, setCwd] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [featuresLoading, setFeaturesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [featuresFor, setFeaturesFor] = useState<PetPreferences | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  useEffect(() => {
    if (!canRead) return;
    let disposed = false;
    void Promise.all(hosts.map(async (host) => ({ host, info: await host.connection.omp.host.info() }))).then((entries) => {
      if (disposed) return;
      setLocalHosts(entries.filter(({ info }) => info.desktopManaged === true).map(({ host }) => host));
      setDiscoveryError(null);
    }, (error) => { if (!disposed) setDiscoveryError(error instanceof Error ? error.message : String(error)); });
    return () => { disposed = true; };
  }, [hosts, canRead]);
  const selectedHost = localHosts.find((host) => host.id === hostId) ?? localHosts[0] ?? null;
  const connection = selectedHost?.connection;
  useEffect(() => {
    if (!connection) { setLoading(false); return; }
    let disposed = false;
    let request = 0;
    const load = async () => {
      const current = ++request;
      setLoading(true);
      try {
        const [context, snapshot] = await Promise.all([ctx.rpc(petCreationContextRpc, {}), connection.omp.providers.waitForReady()]);
        const provider = snapshot.entries.find((entry) => entry.provider === "omp" && entry.enabled && entry.status === "ready");
        const models = provider?.models?.filter((model) => model.isSelectable !== false) ?? [];
        if (!provider || !models.length) throw new Error(snapshot.entries.find((entry) => entry.provider === "omp")?.error ?? t("desktop.pets.noOmpModel"));
        const defaultModel = models.find((model) => model.isDefault) ?? models[0]!;
        if (disposed || current !== request) return;
        setProvider(provider);
        setCwd(context.cwd);
        setPreferences((preferences) => preferences.model ? preferences : { ...preferences, provider: "omp", model: defaultModel.id, ...(provider.defaultModeId ? { modeId: provider.defaultModeId } : {}), ...(defaultModel.defaultThinkingOptionId ? { thinkingOptionId: defaultModel.defaultThinkingOptionId } : {}) });
        setError(null);
      } catch (error) { if (!disposed && current === request) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (!disposed && current === request) setLoading(false); }
    };
    const release = connection.omp.providers.subscribe(() => { void load(); });
    void load();
    return () => { disposed = true; release(); };
  }, [ctx, connection, t]);
  useEffect(() => {
    if (!connection || !cwd || !preferences.model) return;
    let disposed = false;
    setFeaturesLoading(true);
    void connection.omp.providers.listFeatures({ ...preferences, cwd, provider: `${preferences.provider}/${preferences.model}` }).then((result) => {
      if (disposed) return;
      if (result.error) throw new Error(result.error);
      setFeatures(result.features ?? []);
      setFeatureError(null);
      setFeaturesFor(preferences);
    }).catch((error) => { if (!disposed) setFeatureError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (!disposed) setFeaturesLoading(false); });
    return () => { disposed = true; };
  }, [connection, cwd, preferences]);
  const models = provider?.models?.filter((model) => model.isSelectable !== false) ?? [];
  const model = models.find((model) => model.id === preferences.model);
  const selectionError = !canRead ? t("desktop.pets.creationReadPermissionRequired") : !selectedHost ? discoveryError ?? t("desktop.pets.noLocalHost") : !model && !loading ? t("desktop.pets.noOmpModel") : !canCreate ? t("desktop.pets.creationPermissionRequired") : null;
  const ready = Boolean(canCreate && selectedHost && model && !loading && !featuresLoading && featuresFor === preferences && !error && !featureError);
  return { host: selectedHost, hosts: localHosts, setHostId, preferences, setPreferences, models, modes: provider?.modes ?? [], model, features, ready, error: error ?? featureError ?? selectionError };
}
function PetCreator({ context: ctx, disabled, theme }: { context: PluginClientContext; disabled: boolean; theme: PluginSettingsPageProps["theme"] }) {
  const { t, locale } = usePetTranslation();
  const [error, setError] = useState<string | null>(null);
  const authoring = getPetAuthoringDraft(ctx.installation.id);
  const { description, creating } = useSyncExternalStore(authoring.subscribe, authoring.getSnapshot, authoring.getSnapshot);
  const initialPreferences = useRef(authoring.getSnapshot().preferences).current;
  const draft = usePetCreationDraft(ctx, initialPreferences);
  useEffect(() => { authoring.patch({ preferences: draft.preferences }); }, [authoring, draft.preferences]);
  const controlsDisabled = disabled || creating;
  const selectModel = (id: string) => {
    const model = draft.models.find((model) => model.id === id)!;
    draft.setPreferences((preferences) => ({ ...preferences, provider: "omp", model: id, thinkingOptionId: model.thinkingOptions?.some((option) => option.id === preferences.thinkingOptionId) ? preferences.thinkingOptionId : model.defaultThinkingOptionId }));
  };
  const create = async () => {
    if (!draft.ready || !draft.host) return;
    const host = draft.host;
    authoring.patch({ creating: true });
    setError(null);
    try {
      const workspace = await ctx.rpc(petPrepareCreationRpc, { description: description.trim() });
      await launchDesktopPetCreation({ host: { serverId: host.id, omp: host.connection.omp, openAgent: (agentId) => ctx.native.invoke<void>("navigation.openAgent", { serverId: host.id, agentId }) }, workspace, preferences: draft.preferences, locale });
    } catch (error) { setError(t("desktop.pets.createFailed", { message: error instanceof Error ? error.message : String(error) })); }
    finally { authoring.patch({ creating: false }); }
  };
  const choice = (title: string, values: readonly { id: string; label: string; description?: string }[], value: string | undefined | null, select: (id: string) => void) => <View style={styles.creation}><Text style={{ color: theme.colors.foregroundMuted }}>{title}</Text><View style={styles.actions}>{values.map((option) => <Action key={option.id} title={option.label} selected={option.id === value} disabled={controlsDisabled} onPress={() => select(option.id)} color={theme.colors.foreground} accent={theme.colors.accent} />)}</View></View>;
  return <View style={styles.creation}><Text style={[styles.title, { color: theme.colors.foreground }]}>{t("desktop.pets.createTitle")}</Text><Text style={{ color: theme.colors.foregroundMuted }}>{t("desktop.pets.createHint")}</Text>
    {draft.hosts.length > 1 ? choice(t("desktop.pets.creationHost"), draft.hosts.map(({ id, label }) => ({ id, label })), draft.host?.id, draft.setHostId) : null}
    {choice(t("agentControls.hints.model"), draft.models, draft.preferences.model, selectModel)}
    {choice(t("agentControls.mode.title"), draft.modes.map((mode) => ({ ...mode, label: t(`agentControls.mode.options.${MODE_LABEL_KEYS[mode.id] ?? mode.id}`, { defaultValue: mode.label }) })), draft.preferences.modeId, (modeId) => draft.setPreferences((preferences) => ({ ...preferences, modeId })))}
    {draft.model?.thinkingOptions?.length ? choice(t("agentControls.thinking.title"), draft.model.thinkingOptions.map((option) => ({ ...option, label: t(`agentControls.thinking.options.${option.id}`, { defaultValue: option.label }) })), draft.preferences.thinkingOptionId, (thinkingOptionId) => draft.setPreferences((preferences) => ({ ...preferences, thinkingOptionId }))) : null}
    {draft.features.map((feature) => feature.type === "toggle" ? <Action key={feature.id} title={`${feature.label}: ${t(feature.value ? "agentControls.features.on" : "agentControls.features.off")}`} selected={feature.value} disabled={controlsDisabled} onPress={() => draft.setPreferences((preferences) => ({ ...preferences, featureValues: { ...preferences.featureValues, [feature.id]: !feature.value } }))} color={theme.colors.foreground} accent={theme.colors.accent} /> : <View key={feature.id} style={styles.creation}>
      {choice(feature.label, feature.options, feature.value, (value) => draft.setPreferences((preferences) => ({ ...preferences, featureValues: { ...preferences.featureValues, [feature.id]: value } })))}
      <Action title={t("agentControls.mode.options.default")} selected={feature.value === null} disabled={controlsDisabled} onPress={() => draft.setPreferences((preferences) => ({ ...preferences, featureValues: { ...preferences.featureValues, [feature.id]: null } }))} color={theme.colors.foreground} accent={theme.colors.accent} />
    </View>)}
    <TextInput multiline value={description} onChangeText={(description) => authoring.patch({ description })} editable={!creating} maxLength={8000} placeholder={t("desktop.pets.descriptionPlaceholder")} accessibilityLabel={t("desktop.pets.descriptionLabel")} style={[styles.description, { borderColor: theme.colors.foregroundMuted, color: theme.colors.foreground }]} />
    <Action title={t(creating ? "desktop.pets.creating" : "desktop.pets.create")} disabled={controlsDisabled || !draft.ready} onPress={() => { void create(); }} color={theme.colors.foreground} accent={theme.colors.accent} />
    {error || draft.error ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{error ?? draft.error}</Text> : null}
  </View>;
}
function DesktopPetActivitySync({ context: ctx }: { context: PluginClientContext }) {
  const { t } = usePetTranslation();
  const { theme } = useUnistyles();
  const hosts = usePetHosts(ctx);
  const [snapshot, setSnapshot] = useState<readonly PetHostActivity[]>([]);
  const [senderId, setSenderId] = useState<number | null>(null);
  const directories = useRef(new Map<string, { connection: PetConnectedHost["connection"]; directory: PetHostActivityDirectory }>());
  const connectionKey = useRef(0);
  const revalidations = useRef(new Map<string, string>());
  const reportError = useCallback((error: unknown) => { if (!ctx.signal.aborted) console.error(t("desktop.pets.activityFailed"), error); }, [ctx, t]);
  useEffect(() => {
    let disposed = false;
    void ctx.native.invoke<{ senderId: number }>("client.identity").then(({ senderId }) => { if (!disposed) setSenderId(senderId); }).catch(reportError);
    return () => { disposed = true; };
  }, [ctx, reportError]);
  useEffect(() => {
    const publish = () => { if (!ctx.signal.aborted) setSnapshot([...directories.current.values()].map(({ directory }) => directory.snapshot())); };
    for (const [id, entry] of directories.current) {
      if (!hosts.some((host) => host.id === id && host.connection === entry.connection)) { entry.directory.dispose(); directories.current.delete(id); }
    }
    for (const host of hosts) {
      if (directories.current.has(host.id)) continue;
      const directory = new PetHostActivityDirectory(host.connection.omp, String(++connectionKey.current), publish);
      directories.current.set(host.id, { connection: host.connection, directory });
      void directory.start().catch(reportError);
    }
    publish();
  }, [ctx, hosts, reportError]);
  useEffect(() => () => { for (const { directory } of directories.current.values()) directory.dispose(); directories.current.clear(); }, [ctx]);
  // Desktop's registered Unistyles theme provides the restored appearance font.
  const appearanceTheme = theme as { fontFamily: { ui: string } };
  const fontFamily = appearanceTheme.fontFamily.ui;
  const activity = useMemo<DesktopPetActivity>(() => {
    const serverIds = new Set(snapshot.map(({ serverId }) => serverId));
    const tasks = snapshot.flatMap((host) => deriveDesktopPetTasks(host.agents, serverIds, t("desktop.pets.untitledTask"), host.serverId, host.resolveAgentLabel));
    const revisions = Object.fromEntries(snapshot.map((host) => [host.serverId, host.revision]));
    return { tasks, revisions, connected: snapshot.length > 0, serverIds: [...serverIds], fontFamily, labels: { idle: t("desktop.pets.activity.idle"), offline: t("desktop.pets.activity.offline"), running: t("desktop.pets.activity.running"), needs_input: t("desktop.pets.activity.needsInput"), ready: t("desktop.pets.activity.ready"), blocked: t("desktop.pets.activity.blocked"), openApp: t("desktop.pets.activity.openApp"), openTask: t("desktop.pets.activity.openTask"), hide: t("desktop.pets.activity.hide"), resetPosition: t("desktop.pets.activity.resetPosition"), taskCount: t("desktop.pets.activity.taskCount") } };
  }, [snapshot, fontFamily, t]);
  useEffect(() => {
    if (senderId === null) return;
    let disposed = false;
    void ctx.rpc(petActivityRpc, { senderId, activity }).then(async ({ revalidate }) => {
      for (const { serverId, generation } of revalidate) {
        if (disposed || ctx.signal.aborted) return;
        const entry = directories.current.get(serverId);
        if (!entry) continue;
        const fingerprint = JSON.stringify([generation, activity.revisions[serverId], entry.directory.connectionKey]);
        if (revalidations.current.get(serverId) === fingerprint) continue;
        revalidations.current.set(serverId, fingerprint);
        await entry.directory.refresh(generation);
      }
    }).catch((error) => { if (!disposed) reportError(error); });
    return () => { disposed = true; };
  }, [activity, ctx, senderId, reportError]);
  return null;
}
const styles = StyleSheet.create({ page: { padding: 16, gap: 16 }, row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }, title: { fontSize: 15, fontWeight: "600" }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }, gallery: { flexDirection: "row", flexWrap: "wrap", gap: 12 }, petCard: { width: 168, padding: 12, borderWidth: 1, borderRadius: 10, gap: 6 }, preview: { width: "100%", height: 96 }, creation: { gap: 10, paddingTop: 16 }, description: { minHeight: 76, padding: 12, borderWidth: 1, borderRadius: 8 } });
