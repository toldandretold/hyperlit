// Fake Fireworks — an OpenAI-compatible /chat/completions server the
// translation billing e2e points a REAL queue worker at (LLM_BASE_URL
// override), so TranslateBookJob runs end-to-end without spending a cent.
//
// It answers HtmlTranslator's batch prompts: the fragment map is the JSON
// object after the LAST blank line of the final user message (exactly what
// tests/Feature/Translation/BookTranslationTest.php's fakeFireworksBook()
// parses), and the reply is a JSON object of id → translation built from the
// ANSWERS map below — which is keyed to the literal node text that
// `php artisan e2e:seed-translation-fixture` seeds. Change one without the
// other and fragments go unanswered.
//
// STRICT by design: an unknown fragment is OMITTED from the reply (never
// echoed), so drift between fixture and fake surfaces as a failed run, not a
// silently-Chinese "translation". Unknowns are also recorded for assertion.
//
// Usage from a spec (in-process — no child process to babysit):
//   const fake = await startFakeFireworks();
//   // worker env: LLM_BASE_URL = `http://127.0.0.1:${fake.port}/v1`
//   fake.setOmit(['注释内容。']);   // fault injection: never answer the footnote
//   fake.requests                   // [{fragments: [...], model}] per LLM call
//   fake.unknownFragments           // anything sent that ANSWERS doesn't know
//   await fake.close();
//
// Fixed usage per request (1000 prompt / 500 completion tokens) makes the
// charge exactly computable: requests × (1000/1e6×$3 + 500/1e6×$15) × tier.
import http from 'node:http';

export const USAGE = { prompt_tokens: 1000, completion_tokens: 500 };

/** Keyed to e2e:seed-translation-fixture's node text (zh → en direction). */
export const ANSWERS = {
  '第一章': 'Chapter One',
  '小六走进屋子<x1/>。<g2>他笑了</g2>。': 'Xiao Liu walked into the room<x1/>. <g2>He laughed</g2>.',
  '注释内容。': 'A note.',
};

export async function startFakeFireworks(port = 0) {
  const requests = [];
  const unknownFragments = [];
  let omit = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
          const payload = JSON.parse(body);
          const content = payload.messages[payload.messages.length - 1].content;
          // The map may BE the whole message (no context preamble on the
          // first batch) — mirror Str::afterLast's whole-string fallback.
          const sep = content.lastIndexOf('\n\n');
          const fragments = JSON.parse(sep === -1 ? content : content.slice(sep + 2));
          requests.push({ fragments: Object.values(fragments), model: payload.model });

          const reply = {};
          for (const [id, text] of Object.entries(fragments)) {
            if (omit.includes(text)) continue;
            if (Object.prototype.hasOwnProperty.call(ANSWERS, text)) {
              reply[id] = ANSWERS[text];
            } else {
              unknownFragments.push(text);
              // eslint-disable-next-line no-console
              console.error(`[fake-fireworks] UNKNOWN fragment (omitted): ${text.slice(0, 120)}`);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(reply) } }],
            usage: { ...USAGE },
          }));
          return;
        }

        if (req.method === 'POST' && req.url === '/_control') {
          const cmd = JSON.parse(body || '{}');
          if (Array.isArray(cmd.omit)) omit = cmd.omit;
          if (cmd.reset) { omit = []; requests.length = 0; unknownFragments.length = 0; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, omit }));
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (err) {
        // A malformed request must fail the RUN loudly, not hang the worker.
        // eslint-disable-next-line no-console
        console.error('[fake-fireworks] error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    requests,
    unknownFragments,
    setOmit(texts) { omit = texts; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Manual debugging: `node tests/e2e/fixtures/fake-fireworks.mjs 8099`
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeFireworks(Number(process.argv[2] ?? 0));
  // eslint-disable-next-line no-console
  console.log(`fake-fireworks listening on http://127.0.0.1:${fake.port}/v1/chat/completions`);
}
