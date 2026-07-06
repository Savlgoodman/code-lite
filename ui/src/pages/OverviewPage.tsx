import { useEffect, useMemo, useState } from "react";

import { BarChart3, Coins, Database, Layers, RefreshCw } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { loadTodayBillingUsage } from "../services/billingUsageStore";
import type { BillingUsageSeriesPoint, BillingUsageSummary } from "../types";
import "./OverviewPage.css";

interface TrendPoint extends BillingUsageSeriesPoint {
  hour: number;
  label: string;
}

function formatNumber(value: number | undefined): string {
  return Math.round(value ?? 0).toLocaleString();
}

function formatUsd(value: number | undefined): string {
  const amount = value ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    return "$0.000000";
  }
  if (amount < 0.000001) {
    return "<$0.000001";
  }
  if (amount < 0.01) {
    return `$${amount.toFixed(6)}`;
  }
  return `$${amount.toFixed(4)}`;
}

function formatAxisUsd(value: number): string {
  if (value <= 0) {
    return "$0";
  }
  if (value < 1) {
    return `$${value.toFixed(2)}`;
  }
  return `$${Math.round(value)}`;
}

function formatTokenAxis(value: number): string {
  if (value <= 0) {
    return "0k";
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return `${Math.round(value)}`;
}

function zeroTotals(): Omit<BillingUsageSeriesPoint, "bucket" | "date"> {
  return {
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
    turns: 0,
    unknownCostTurns: 0,
  };
}

function bucketHour(bucket: string | undefined): number {
  const match = String(bucket ?? "").match(/^(\d{1,2})/);
  if (!match) {
    return 0;
  }
  return Math.min(23, Math.max(0, Number(match[1]) || 0));
}

function buildTrendPoints(series: BillingUsageSeriesPoint[] | undefined): TrendPoint[] {
  const byHour = new Map<number, BillingUsageSeriesPoint>();
  for (const point of series ?? []) {
    byHour.set(bucketHour(point.bucket), point);
  }

  return Array.from({ length: 24 }, (_, hour) => {
    const bucket = `${String(hour).padStart(2, "0")}:00`;
    return {
      ...zeroTotals(),
      ...byHour.get(hour),
      bucket,
      hour,
      label: bucket,
    };
  });
}

function formatBucketLabel(date: string | undefined, bucket: string): string {
  const parts = String(date ?? "").split("-");
  const labelDate = parts.length === 3 ? `${parts[1]}/${parts[2]}` : "今天";
  return `${labelDate} ${bucket}`;
}

function xTickFormatter(value: string): string {
  const hour = bucketHour(value);
  return hour % 2 === 1 ? value : "";
}

export function OverviewPage() {
  const [billingUsage, setBillingUsage] = useState<BillingUsageSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  function refresh() {
    setLoading(true);
    setError("");
    loadTodayBillingUsage()
      .then((summary) => {
        setBillingUsage(summary);
      })
      .catch((err) => {
        console.error("Failed to load billing usage:", err);
        setError("费用统计加载失败。");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  const totals = billingUsage?.totals;
  const trendPoints = useMemo(() => buildTrendPoints(billingUsage?.series), [billingUsage]);
  const hasTrendData = trendPoints.some((point) => point.totalTokens > 0 || point.estimatedCostUsd > 0);

  return (
    <main className="main-panel overview-panel">
      <header className="overview-header">
        <div>
          <span className="eyebrow">今日使用情况</span>
          <h1>费用总览</h1>
        </div>
        <button className="overview-refresh" disabled={loading} onClick={refresh} type="button">
          <RefreshCw className={loading ? "spin-icon" : ""} size={16} />
          <span>刷新</span>
        </button>
      </header>

      <div className="overview-scroll">
        {error ? <div className="overview-error">{error}</div> : null}

        <section className="overview-section">
          <div className="overview-summary-grid">
            <div className="overview-stat">
              <span className="overview-stat-icon"><Database size={17} /></span>
              <span>今日 Token</span>
              <strong>{formatNumber(totals?.totalTokens)}</strong>
              <small>输入 {formatNumber(totals?.inputTokens)} / 输出 {formatNumber(totals?.outputTokens)}</small>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-icon"><Coins size={17} /></span>
              <span>估算费用</span>
              <strong>{formatUsd(totals?.estimatedCostUsd)}</strong>
              <small>{totals?.unknownCostTurns ? `${totals.unknownCostTurns} 轮价格未知` : "已按本地价格表估算"}</small>
            </div>
            <div className="overview-stat">
              <span className="overview-stat-icon"><Layers size={17} /></span>
              <span>模型用量</span>
              <strong>{formatNumber(billingUsage?.models.length)}</strong>
              <small>{formatNumber(totals?.turns)} 轮完成请求</small>
            </div>
          </div>
        </section>

        <section className="overview-section">
          <div className="overview-section-title">
            <strong>使用趋势</strong>
            <span>{billingUsage?.date ?? "今天"}</span>
          </div>
          <div className="overview-chart" aria-label="今日 Token 和费用使用趋势">
            <ResponsiveContainer height={330} width="100%">
              <ComposedChart data={trendPoints} margin={{ bottom: 14, left: 4, right: 18, top: 18 }}>
                <defs>
                  <linearGradient id="cache-hit-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#a855f7" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#a855f7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#edf0f2" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="bucket"
                  interval={0}
                  minTickGap={18}
                  tick={{ fill: "#6e7480", fontSize: 12 }}
                  tickFormatter={xTickFormatter}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  tick={{ fill: "#6e7480", fontSize: 12 }}
                  tickFormatter={formatTokenAxis}
                  tickLine={false}
                  width={52}
                  yAxisId="tokens"
                />
                <YAxis
                  axisLine={false}
                  orientation="right"
                  tick={{ fill: "#6e7480", fontSize: 12 }}
                  tickFormatter={formatAxisUsd}
                  tickLine={false}
                  width={48}
                  yAxisId="cost"
                />
                <Tooltip
                  contentStyle={{
                    border: "1px solid #e4e0dc",
                    borderRadius: 8,
                    boxShadow: "0 12px 30px rgba(30, 35, 42, 0.1)",
                  }}
                  formatter={(value, name) => {
                    const numericValue = typeof value === "number" ? value : Number(value) || 0;
                    if (name === "成本") {
                      return [formatUsd(numericValue), name];
                    }
                    return [formatNumber(numericValue), name];
                  }}
                  labelFormatter={(label) => formatBucketLabel(billingUsage?.date, String(label))}
                />
                <Legend iconType="circle" wrapperStyle={{ paddingTop: 8 }} />
                <Line
                  dataKey="estimatedCostUsd"
                  dot={false}
                  name="成本"
                  stroke="#ff4d67"
                  strokeDasharray="4 4"
                  strokeWidth={2}
                  type="monotone"
                  yAxisId="cost"
                />
                <Line
                  dataKey="cachedWriteTokens"
                  dot={false}
                  name="缓存创建"
                  stroke="#ff8a3d"
                  strokeWidth={2}
                  type="monotone"
                  yAxisId="tokens"
                />
                <Area
                  dataKey="cachedReadTokens"
                  fill="url(#cache-hit-fill)"
                  name="缓存命中"
                  stroke="#a855f7"
                  strokeWidth={2}
                  type="monotone"
                  yAxisId="tokens"
                />
                <Line
                  dataKey="inputTokens"
                  dot={false}
                  name="输入"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  type="monotone"
                  yAxisId="tokens"
                />
                <Line
                  dataKey="outputTokens"
                  dot={false}
                  name="输出"
                  stroke="#22c55e"
                  strokeWidth={2}
                  type="monotone"
                  yAxisId="tokens"
                />
              </ComposedChart>
            </ResponsiveContainer>

            {!hasTrendData ? <div className="overview-chart-empty">今天还没有可统计的模型用量。</div> : null}
          </div>
        </section>

        <section className="overview-section">
          <div className="overview-section-title">
            <strong>模型统计</strong>
            <span>按 Token 总量排序</span>
          </div>
          <div className="overview-model-list">
            {(billingUsage?.models.length ?? 0) > 0 ? (
              billingUsage?.models.map((model) => (
                <div className="overview-model-row" key={model.key ?? `${model.runtime}:${model.modelId}`}>
                  <div>
                    <strong>{model.modelLabel || model.modelId}</strong>
                    <span>{model.runtime}</span>
                  </div>
                  <div className="overview-model-metrics">
                    <span>Input {formatNumber(model.inputTokens)}</span>
                    <span>Output {formatNumber(model.outputTokens)}</span>
                    <span>Cache {formatNumber(model.cachedReadTokens + model.cachedWriteTokens)}</span>
                    <strong>{formatNumber(model.totalTokens)} tokens</strong>
                    <em>{formatUsd(model.estimatedCostUsd)}</em>
                  </div>
                </div>
              ))
            ) : (
              <div className="overview-empty">暂无模型统计。</div>
            )}
          </div>
        </section>

        <section className="overview-section">
          <div className="overview-section-title">
            <strong>最近记录</strong>
            <span>只展示脱敏使用情况</span>
          </div>
          <div className="overview-entry-list">
            {(billingUsage?.recentEntries.length ?? 0) > 0 ? (
              billingUsage?.recentEntries.slice(0, 8).map((entry) => (
                <div className="overview-entry-row" key={entry.id}>
                  <BarChart3 size={16} />
                  <div>
                    <strong>{entry.modelLabel || entry.modelId || "未知模型"}</strong>
                    <span>{entry.workspaceLabel || entry.runtime || "code-lite"}</span>
                  </div>
                  <span>{formatNumber(entry.usage?.totalTokens)} tokens</span>
                  <em>{formatUsd(entry.cost?.estimatedCostUsd)}</em>
                </div>
              ))
            ) : (
              <div className="overview-empty">暂无最近记录。</div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
