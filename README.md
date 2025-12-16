# tg-ghost-tag

Invisible mentions for Telegram bots using zero-width characters.

## Install

```bash
npm install tg-ghost-tag
```

## Usage

### Classic mode

```ts
import { buildGhostPayloads, sendGhostMentions } from 'tg-ghost-tag';

const payloads = buildGhostPayloads(chatId, [123, 456, 789], {
  before: 'Hello!',
  after: ''
});

await sendGhostMentions(chatId, userIds, { before: '👋' }, {
  token: 'BOT_TOKEN',
  maxPerMessage: 50
});
```

### Smart mode

Automatically places invisible mentions within your message:

```ts
const payloads = buildGhostPayloads(chatId, userIds, {
  message: 'Meeting starts at 10:00!',
  replaceTargets: ['!', '.'],       // insert after punctuation
  fallbackPosition: 'end'           // fallback if no match
});
```

## API

| Function | Description |
|----------|-------------|
| `buildGhostPayloads()` | Create payloads for `sendMessage` |
| `sendGhostMentions()` | Send mentions via Bot API |
| `editCascade()` | Sequential edit trick for stealth |
| `buildInvisibleText()` | Low-level text builder |

## GhostTemplate options

| Option | Type | Description |
|--------|------|-------------|
| `before` / `after` | `string` | Classic mode: text before/after INV chars |
| `message` | `string` | Smart mode: full message text |
| `char` | `string` | Force specific INV character |
| `charCandidates` | `string[]` | INV char candidates (auto-pick) |
| `replaceTargets` | `string[]` | Smart mode: insert after these chars |
| `replacePosition` | `'start'` \| `'end'` \| `number` | Where to insert |
| `fallbackPosition` | `'start'` \| `'end'` | Fallback if no anchor found |
| `separateLineForMentions` | `boolean` | Add `\n` before INV chars |
| `trailingNewline` | `boolean` | Add `\n` after INV chars |

## BuildOptions

| Option | Default | Description |
|--------|---------|-------------|
| `maxPerMessage` | `100` | Max mentions per message |
| `maxTextLength` | `4096` | Telegram text limit |
| `onOverflow` | `'split'` | `'split'` or `'error'` |

## Requirements

Node.js 18+ (uses native `fetch`)

## License

MIT
