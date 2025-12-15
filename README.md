# tg-ghost-tag

Invisible mentions for Telegram bots using zero-width characters.

## Install

```bash
npm install tg-ghost-tag
```

## Usage

```ts
import { buildGhostPayloads, sendGhostMentions } from 'tg-ghost-tag';

// Build payloads manually
const payloads = buildGhostPayloads(chatId, [123, 456, 789], {
  before: 'Hello!',
  after: ''
});

// Or send directly
await sendGhostMentions(chatId, userIds, { before: '👋' }, {
  token: 'BOT_TOKEN',
  maxPerMessage: 5
});
```

## API

| Function | Description |
|----------|-------------|
| `buildGhostPayloads()` | Create payloads for `sendMessage` |
| `sendGhostMentions()` | Send mentions via Bot API |
| `editCascade()` | Sequential edit trick for stealth |
| `buildInvisibleText()` | Low-level text builder |

## Requirements

Node.js 18+ (uses native `fetch`)

## License

MIT

