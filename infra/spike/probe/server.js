import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
createServer(async (request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (request.url === '/echo') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ body: Buffer.concat(chunks).toString('utf8') }));
    return;
  }
  if (request.url === '/probe' && process.env.TARGET_URL) {
    const audience = process.env.TARGET_URL;
    const token = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=' + encodeURIComponent(audience), { headers: { 'Metadata-Flavor': 'Google' } }).then((item) => item.text());
    const result = await fetch(audience + '/healthz', { headers: { authorization: 'Bearer ' + token } });
    response.writeHead(result.status).end(await result.text());
    return;
  }
  response.writeHead(404).end();
}).listen(port);
