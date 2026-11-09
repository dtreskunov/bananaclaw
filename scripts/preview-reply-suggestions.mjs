import http from 'node:http';
import fs from 'node:fs';

const resources = new Map([
  ['/', ['reply-suggestions-prototype.html', 'text/html']],
  ['/dist/reply-suggestions-demo.js', ['dist/reply-suggestions-demo.js', 'text/javascript']],
  ['/dist/reply-suggestions-demo.css', ['dist/reply-suggestions-demo.css', 'text/css']],
]);
const root = new URL('../src/ui/client/chat/', import.meta.url);
const server = http.createServer((request, response) => {
  const resource = resources.get(request.url);
  if (!resource) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': resource[1], 'Cache-Control': 'no-store' });
  const stream = fs.createReadStream(new URL(resource[0], root));
  stream.on('error', (error) => {
    console.error('Prototype resource unavailable:', error);
    response.destroy(error);
  });
  stream.pipe(response);
});
server.on('error', (error) => {
  console.error('Prototype server failed:', error);
  process.exitCode = 1;
});
server.listen(8796, '127.0.0.1', () => console.log('Prototype ready on http://127.0.0.1:8796'));
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
