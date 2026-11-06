import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import { Card } from "./SettingsPrimitives";

export interface InstaboxMachineRow {
  id: string;
  name: string;
  state: string;
  ready: boolean;
  assignedBotId: string | null;
  assignedBotName: string | null;
  shared?: boolean;
}

export function InstaboxComputersCard({
  configured,
  machines,
  bots,
  loading,
  error,
  pendingId,
  onRefresh,
  onAssign,
  onClear,
  onReconnect,
}: {
  configured: boolean;
  machines: InstaboxMachineRow[];
  bots: Array<{ id: string; name: string }>;
  loading: boolean;
  error: string | null;
  pendingId: string | null;
  onRefresh: () => void;
  onAssign: (machineId: string, botId: string) => void;
  onClear: (botId: string) => void;
  onReconnect: (botId: string) => void;
}) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  return (
    <Card title={t("instabox.title")} subtitle={t("instabox.subtitle")}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          {configured ? t("instabox.subtitle") : t("instabox.needsKey")}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label={t("instabox.refreshAria")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> {t("instabox.refresh")}
        </button>
      </div>
      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      <div className="mt-3 overflow-hidden rounded-xl border border-hairline/40">
        {loading && machines.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> {t("instabox.checking")}
          </div>
        ) : !configured ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">{t("instabox.needsKey")}</div>
        ) : machines.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">{t("instabox.none")}</div>
        ) : machines.map((machine, index) => {
          const selected = choice[machine.id] ?? machine.assignedBotId ?? "";
          const busy = pendingId === machine.id;
          return (
            <div key={machine.id} className={cn("px-3 py-3", index > 0 && "border-t border-hairline/35")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[14px] font-medium text-ink">{machine.name}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px]", machine.ready ? "bg-success/15 text-success" : "bg-control text-ink-secondary")}>
                  {machine.ready ? t("instabox.ready") : machine.state || t("instabox.notRunning")}
                </span>
              </div>
              <div className="mt-1 text-[12px] text-ink-secondary">
                {machine.shared ? t("instabox.shared") : machine.assignedBotName ? t("instabox.assigned", { name: machine.assignedBotName }) : t("instabox.unassigned")}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`instabox-bot-${machine.id}`}>{t("instabox.chooseBot")}</label>
                <select
                  id={`instabox-bot-${machine.id}`}
                  className="rounded-lg border border-hairline/40 bg-panel px-2 py-1.5 text-[12px] text-ink"
                  value={selected}
                  onChange={(event) => setChoice((current) => ({ ...current, [machine.id]: event.target.value }))}
                >
                  <option value="">{t("instabox.unassigned")}</option>
                  {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
                <button
                  type="button"
                  disabled={busy || !selected || selected === machine.assignedBotId}
                  onClick={() => onAssign(machine.id, selected)}
                  className="rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {t("instabox.assign")}
                </button>
                {machine.assignedBotId && (
                  <>
                    <button type="button" disabled={busy} onClick={() => onClear(machine.assignedBotId!)} className="rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-40">{t("instabox.clear")}</button>
                    <button type="button" disabled={busy} onClick={() => onReconnect(machine.assignedBotId!)} className="rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control disabled:opacity-40">{t("instabox.reconnect")}</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function InstaboxComputersSection() {
  const { state } = useStore();
  const [machines, setMachines] = useState<InstaboxMachineRow[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await api<{ configured?: boolean; machines?: InstaboxMachineRow[]; problem?: string | null }>("/api/instabox/machines");
      setConfigured(body.configured === true);
      setMachines(Array.isArray(body.machines) ? body.machines : []);
      setError(body.problem ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  const bots = state.bots.filter((bot) => !bot.hidden).map((bot) => ({ id: bot.id, name: bot.name }));
  const run = async (machineId: string, path: string, body: Record<string, unknown>) => {
    setPendingId(machineId);
    setError(null);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  };
  return (
    <InstaboxComputersCard
      configured={configured}
      machines={machines}
      bots={bots}
      loading={loading}
      error={error}
      pendingId={pendingId}
      onRefresh={() => setRefreshKey((key) => key + 1)}
      onAssign={(machineId, botId) => void run(machineId, "/api/instabox/assignments", { botId, machineId })}
      onClear={(botId) => {
        const machine = machines.find((row) => row.assignedBotId === botId);
        if (machine) void run(machine.id, "/api/instabox/assignments", { botId, machineId: null });
      }}
      onReconnect={(botId) => {
        const machine = machines.find((row) => row.assignedBotId === botId);
        if (machine) void run(machine.id, "/api/instabox/reconnect", { botId });
      }}
    />
  );
}
