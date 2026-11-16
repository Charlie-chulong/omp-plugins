import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { PluginClientContext, PluginSettingsPageProps } from "@omp-desktop/plugin";
import { openMonitorRpc } from "./rpc.js";

export function AgentSpeedSettings({ context, installation, theme }: PluginSettingsPageProps & { context: PluginClientContext }) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const open = async () => {
    setOpening(true);
    setFailed(false);
    try {
      await context.rpc(openMonitorRpc, {});
    } catch {
      // Native errors can include source/user-data paths. Keep recovery copy local and private.
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setOpening(false);
    }
  };
  const disabled = !installation.enabled || opening;
  const label = opening ? (zh ? "正在打开…" : "Opening…") : (zh ? "打开 Agent Speed" : "Open Agent Speed");
  return <View style={{ padding: 20, gap: 16, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>Agent Speed</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>{zh ? "查看本地 OMP 用量、速度、性能和历史；在监视器设置中管理悬浮球、看板、数据源与价格。" : "View local OMP usage, speed, performance and history. Manage orbs, boards, sources and pricing in monitor settings."}</Text>
    {!installation.enabled ? <Text style={{ color: theme.colors.foregroundMuted }}>{zh ? "启用此插件后即可打开监视器。" : "Enable this plugin to open the monitor."}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy: opening }} disabled={disabled} onPress={() => { void open(); }} style={{ alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: theme.colors.accent, opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ color: theme.colors.accentForeground }}>{label}</Text>
    </Pressable>
    {failed ? <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>{zh ? "无法打开监视器。请重试；若仍失败，请重新启用此插件。" : "Unable to open the monitor. Retry, or re-enable this plugin if the problem continues."}</Text> : null}
  </View>;
}
