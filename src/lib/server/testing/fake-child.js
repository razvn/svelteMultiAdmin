// A stand-in for a built child app: `node <dir>/build` runs this file's copy as build/index.js.
import http from 'node:http';

const server = http.createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = Buffer.concat(chunks).toString();
	const url = new URL(req.url ?? '/', 'http://x');
	if (url.pathname === '/api/health') return void res.end('ok');
	if (url.pathname === '/crash') process.exit(1);
	if (url.pathname === '/redirect')
		return void res.writeHead(302, { location: 'https://app.example.com/next' }).end();
	if (url.pathname === '/cookies') {
		res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
		return void res.end('c');
	}
	res.setHeader('content-type', 'application/json');
	res.end(
		JSON.stringify({
			method: req.method,
			url: req.url,
			headers: req.headers,
			body,
			env: process.env
		})
	);
});
server.listen(Number(process.env.PORT), process.env.HOST);
