// Smoke test: `npm run smoke` (add `-- --send` to also text USER_PHONE through Photon).
// Checks the three outside dependencies before a demo: SpacetimeDB, Nemotron tool calling, Photon.
import { config } from './main/config.js';
import { chat } from './main/llm.js';
import { DbConnection } from './module_bindings/index.js';

const send = process.argv.includes('--send');
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);

async function checkDb() {
  console.log(`SpacetimeDB (${config.stdbUri}, db "${config.stdbDatabase}")`);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      bad('no connection after 5 s. Run "spacetime start" and "npm run db:publish".');
      resolve();
    }, 5000);
    DbConnection.builder()
      .withUri(config.stdbUri)
      .withDatabaseName(config.stdbDatabase)
      .onConnect((c) => {
        c.subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            ok(`connected; ${[...c.db.session.iter()].length} sessions in the database`);
            c.disconnect();
            resolve();
          })
          .subscribeToAllTables();
      })
      .onConnectError((_c, e) => {
        clearTimeout(timer);
        bad(`connect error: ${e.message}`);
        resolve();
      })
      .build();
  });
}

async function checkLlm() {
  console.log(`Nemotron (${config.llmModel})`);
  try {
    const r = await chat([{ role: 'user', content: 'Reply with exactly: ready' }], { maxTokens: 20 });
    ok(`plain call ${r.ms} ms → "${r.content.slice(0, 40)}"`);
  } catch (e: any) {
    bad(`plain call failed: ${e.message}`);
    return;
  }
  try {
    const r = await chat(
      [
        { role: 'system', content: 'You judge whether a window helps the goal. Always answer by calling record_verdict.' },
        { role: 'user', content: JSON.stringify({ goal: 'Finish Dijkstra assignment in Python', window: { app: 'Google Chrome', title: 'r/all - Reddit', url: 'https://www.reddit.com/r/all' } }) },
      ],
      {
        tools: [
          {
            type: 'function',
            function: {
              name: 'record_verdict',
              description: 'Final decision',
              parameters: {
                type: 'object',
                properties: { verdict: { type: 'string', enum: ['on_task', 'off_task'] }, reason: { type: 'string' }, confidence: { type: 'number' } },
                required: ['verdict', 'reason', 'confidence'],
              },
            },
          },
        ],
        maxTokens: 300,
      }
    );
    if (r.toolCalls.length) ok(`native tool call ${r.ms} ms → ${r.toolCalls[0].function.name}(${r.toolCalls[0].function.arguments})`);
    else bad(`no native tool_calls (the agent will use its JSON fallback). Reply: ${r.content.slice(0, 160)}`);
  } catch (e: any) {
    bad(`tool call failed: ${e.message}`);
  }
}

async function checkPhoton() {
  console.log('Photon / iMessage');
  if (!config.spectrumProjectId || !config.spectrumProjectSecret) return bad('SPECTRUM_PROJECT_ID / SECRET missing');
  if (!send) return ok('credentials present (run with -- --send to text USER_PHONE a test message)');
  const { sendText, stopPhoton } = await import('./main/photon.js');
  const r = await sendText(config.userPhone, 'Anchor test: Photon is connected.');
  r.ok ? ok(r.detail) : bad(r.detail);
  await stopPhoton();
}

await checkDb();
await checkLlm();
await checkPhoton();
process.exit(0);
