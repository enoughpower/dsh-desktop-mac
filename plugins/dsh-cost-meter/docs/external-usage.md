# External usage snapshots / 外部用量快照

## English

Another local process can write `$DSH_HOME/storages/cost-meter/external_usage.json` to add usage from the **same account** that bypasses DSH. The plugin reads the file on each state refresh. It never calls Hindsight or any other external service. Settings → Cost shows DSH and external usage separately, plus combined today/month/all-time totals. Expand a source to see its token buckets, calls, costs and up to 90 recent daily rows. DSH session totals remain separate. Official balance reconciliation includes the external snapshot's cost for today when the snapshot is less than 24 hours old; a stale snapshot mutes drift warnings until refreshed. A missing today entry counts as zero.

Write the entire snapshot to a temporary file in the same directory, then atomically rename it to `external_usage.json`. Replace the file on every refresh; **do not append deltas**. The same snapshot can be read repeatedly without double-counting. Use ISO 8601 timestamps with `Z` or an explicit offset. `source` is a stable name (1–64 characters), not a model name. Up to eight sources are accepted. The file is capped at 512 KiB; each source can supply up to 3,660 daily summaries, or the whole file can supply up to 5,000 individual records. Snapshots older than 24 hours are marked stale; those older than 30 days, malformed, oversized, or unreadable are ignored. The producer should refresh regularly and keep historical days in each replacement snapshot. All-time totals cover only the days supplied by the producer.

**Daily summary mode**: `input` means uncached input, `cached` means cache-read input, and `cacheWrite` is a separate optional bucket. All buckets are mutually exclusive. `costUsd` is the exact USD cost calculated by the producer; it is required because daily totals cannot reconstruct peak/off-peak or long-context prices for individual calls. `calls` is the number of calls. Optional `reasoning` is reported separately. Amounts are converted to the selected display currency by the plugin.

```json
{
  "fetchedAt": "2026-09-26T09:00:00Z",
  "sources": [
    {
      "source": "Hindsight",
      "days": {
        "2026-09-25": {
          "input": 4888706,
          "output": 592536,
          "cached": 1082880,
          "calls": 363,
          "costUsd": 1.2345
        }
      }
    }
  ]
}
```

**Call record mode**: send one record per completed call with a stable unique `id` within that source. The plugin calculates USD cost using its configured provider/model prices and each call's timestamp, including the configured DeepSeek peak/off-peak rules. Current price settings are reapplied when the snapshot is read, so use daily `costUsd` summaries if historical costs must remain fixed. An unpriced provider/model invalidates the snapshot instead of silently recording zero cost. `input`, `output`, `cached`, optional `cacheWrite` and `reasoning` have the same meanings as in summary mode. Each record represents one call.

```json
{
  "fetchedAt": "2026-09-26T09:00:00Z",
  "source": "Hindsight",
  "records": [
    {
      "id": "request-abc123",
      "at": "2026-09-25T08:40:00Z",
      "provider": "deepseek",
      "model": "deepseek-chat",
      "input": 1200,
      "output": 250,
      "cached": 100
    }
  ]
}
```

A snapshot can contain a single top-level source as above, or a `sources` array. Each source uses either `days` or `records`, never both. Do not include calls already reported to DSH; source separation prevents same-name model collisions but cannot detect duplicate calls across systems. The file must contain no API keys or other credentials. The budget widget continues to use DSH's own ledger; combined totals appear in the external usage section.

## 中文

其他本地进程可将同一账户、但绕过 DSH 的用量写入 `$DSH_HOME/storages/cost-meter/external_usage.json`。插件每次刷新状态时读取，不直接请求 Hindsight 等服务。设置 → 费用按来源显示外部用量、DSH 与外部合计，以及近 90 天的逐日数据。DSH 会话金额保持独立；官方余额对账会计入 24 小时内有效快照的今日外部费用。快照过期时暂停偏差提示，缺少今日条目按零计。

采集器先在同目录写完整临时文件，再原子重命名为 `external_usage.json`。每次刷新替换整份快照，**不要追加增量**；重复读取不会重复计费。时间使用带 `Z` 或时区偏移的 ISO 8601。`source` 是稳定的来源名称，不是模型名。最多 8 个来源；文件上限 512 KiB；每来源最多 3660 条日汇总，或整份快照最多 5000 条调用记录。超过 24 小时未更新会标为过期；超过 30 天、损坏、过大或不可读的快照会被忽略。刷新时应保留所需的历史日期；累计费用只覆盖采集器提供的日期。

上方第一例为**每日汇总**：`input` 是非缓存输入，`cached` 是缓存读取，可选 `cacheWrite` 是独立缓存写入；各桶互不重叠。`costUsd` 是采集器计算的准确美元费用，必须提供，因为日合计不能还原每次调用的峰谷或长上下文价格。`calls` 是调用次数，`reasoning` 可单独提供。插件按当前显示汇率展示费用。

第二例为**逐次记录**：每次完成的调用提供来源内唯一且稳定的 `id`。插件按 `at`、provider/model 及现有价表计算美元费用，包括 DeepSeek 峰谷规则。快照每次读取会应用当前价格设置；若历史费用必须固定，请使用含 `costUsd` 的日汇总。未知价格的模型会使整份快照失效，避免误记零费用。每个来源只能在 `days` 和 `records` 中选一种。不要包含已由 DSH 记录的调用；来源分栏能区分同名模型，但无法自动识别跨系统重复调用。文件中不要存放密钥。预算图框仍按 DSH 账本计算；合计显示在外部用量区。
