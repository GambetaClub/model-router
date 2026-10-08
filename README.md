# Model Router

A Claude Code mod that picks the model and reasoning effort for every prompt. It asks [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's small decision model, how hard the task is, then sends the turn to the model that fits.

Forked from `jev-model-router` in [claude-code-templates](https://github.com/davila7/claude-code-templates).

## What it does

| Tier | Model | For |
|---|---|---|
| `fast` | Haiku 5.5 | Small, mechanical work: read a file, rename a symbol |
| `balanced` | Sonnet 5.5 | Everyday changes across a few files |
| `deep` | Opus 5.5 | Design, unknown bugs, security, migrations |
| `superDeep` | Fable 5.1 | Big refactors and features that span many files |

- It sets the effort for each prompt: `low`, `medium`, `high` or `xhigh`.
- It picks the main model on the first turn and keeps it until `/clear` or a compaction. Switching models mid-chat would throw away the prompt cache.
- Each subagent gets its own model. Subagents start fresh, so a different model costs nothing there.
- When a prompt has nothing to do with the current chat, the mod holds it back and suggests a new session, with a ready-to-paste `claude --model … '<prompt>'` command. Send the prompt again to run it in the current chat.
- A task that would change production, move money or destroy data gets at least `deep` and `high` effort.

## Install

```sh
git clone https://github.com/GambetaClub/model-router .claude/skills/model-router
```

You need Claude Code 2.1.287 or newer. On an older version, start it with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude`. Accept the trust prompt the first time you open the project.

## Setup

Add this to `~/.claude/settings.json` (user settings, not project settings):

```json
{
  "pluginConfigs": {
    "model-router@skills-dir": {
      "options": { "typesafeApiKey": "…", "timeoutMs": 2000 }
    }
  }
}
```

With no key, the mod falls back to Claude Code's built-in classifier (Haiku). It works, but the classifier only sees the tier names, gives no confidence score, never moves you to a smaller model, and can't do the new-task check.

## What you'll see

```
[Jev Model Router] jev: tier fast (0.99) · effort 0.0 → low (1.00) · risky 0.07 · 396ms
[Jev Model Router] main loop → claude-haiku-5-5, effort low: fast (confidence 0.99)
```

The status line under the prompt reads like `Haiku 5.5 · low effort · fast 99%`.

`/model` and the model's own answer will keep naming your session model. The mod changes each request, not the setting. To see which model really answered, check the session log:

```sh
jq -r 'select(.type=="assistant") | .message.model' ~/.claude/projects/<project>/<session>.jsonl | uniq -c
```

## Options

| Option | Default | What it does |
|---|---|---|
| `typesafeApiKey` / `gatewayApiKey` | none | Jev through TypeSafe (preferred, gives confidence) or the Vercel AI Gateway |
| `fastModel`, `balancedModel`, `deepModel`, `superDeepModel` | `haiku`, `sonnet`, `opus`, `fable` | Alias or full model id per tier |
| `routeMainModel` | `true` | Pick the main chat's model from its first prompt |
| `routeMainEffort` | `true` | Pick the main chat's effort |
| `routeSubagentModel` | `true` | Pick each subagent's model |
| `minUpgradeConfidence` / `minDowngradeConfidence` | `0.3` / `0.6` | How sure Jev must be to move up or down |
| `timeoutMs` | `800` | Wait limit per classification; `2000` avoids timeouts on the first call |
| `logDecisions` | `true` | Show the log lines above |

## Privacy

With a key set, your prompt goes to TypeSafe or Vercel, along with up to five earlier prompts (500 characters each) for the new-task check. For subagents it sends their prompt, description and type. With no key, nothing goes anywhere except Anthropic.

## Tests

```sh
claude plugin test .
```

MIT licensed.
