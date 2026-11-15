// One-command interactive TikTok OAuth flow.
// Usage: node render/tiktok-auth.js
// Runs a temporary HTTPS loopback or prints cloudflared tunnel command for redirect.
import dotenv from 'dotenv';
dotenv.config({ path: `${import.meta.dirname}/../.env`, quiet: true });
import { createServer as createHttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const { authUrl, exchangeCode, TOKEN_FILE } = await import('./tiktok.js');

const state = randomBytes(16).toString('hex');
const url = authUrl(state);
const redirect = new URL(process.env.TIKTOK_REDIRECT_URI);

console.log('\n--- TikTok OAuth ---');
console.log('1. Đảm bảo TikTok App có scope: user.info.basic, video.publish');
console.log(`2. Redirect URI trong app phải khớp: ${redirect.href}`);
console.log(`3. Mở URL sau để cấp quyền:\n   ${url}\n`);

// Try opening browser
try {
	spawn('open', [url], { stdio: 'ignore' }).unref();
} catch {}

// TikTok needs an https redirect: point `cloudflared tunnel --url http://localhost:8787` at this port.
const port = Number(process.env.TIKTOK_AUTH_PORT ?? 8787);
const handler = async (req, res) => {
	const u = new URL(req.url, `http://${req.headers.host}`);
	if (u.pathname !== redirect.pathname) {
		res.writeHead(404).end();
		return;
	}
	const code = u.searchParams.get('code');
	const retState = u.searchParams.get('state');
	const err = u.searchParams.get('error') || u.searchParams.get('error_description');
	if (err) {
		res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`Lỗi TikTok: ${err}`);
		console.error(`TikTok trả lỗi: ${err}`);
		process.exit(1);
	}
	if (!code || retState !== state) {
		res.writeHead(400).end('Mismatched state or missing code');
		return;
	}
	try {
		const token = await exchangeCode(code);
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
			'<h1>Đăng nhập TikTok thành công!</h1><p>Token đã lưu vào data/tiktok-token.json. Bạn có thể đóng tab này.</p>',
		);
		console.log(`Đã lưu token: ${TOKEN_FILE}`);
		console.log(`Creator ID: ${token.open_id}`);
		console.log(`Access token hết hạn sau: ${Math.round(token.expires_in / 3600)} giờ (tự động refresh)`);
		process.exit(0);
	} catch (e) {
		res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`Lỗi đổi token: ${e.message}`);
		console.error(e);
		process.exit(1);
	}
};

// Start a lightweight loopback listener
const server = createHttpServer(handler);
server.on('error', (e) => {
	console.log(`\nKhông bind được port ${port} (${e.message}).`);
	console.log('Nếu bạn dùng cloudflared tunnel hoặc URL khác, hãy paste mã code từ redirect URL vào đây:');
	process.stdout.write('Paste code: ');
	process.stdin.setEncoding('utf8');
	process.stdin.once('data', async (d) => {
		const code = d.trim().replace(/^.*code=([^&]+).*$/, '$1');
		try {
			const t = await exchangeCode(code);
			console.log(`Đã lưu token vào ${TOKEN_FILE} (creator: ${t.open_id})`);
			process.exit(0);
		} catch (err) {
			console.error(`Thất bại: ${err.message}`);
			process.exit(1);
		}
	});
});
server.listen(port, '127.0.0.1', () => {
	console.log(`Đang lắng nghe redirect tại http://127.0.0.1:${port}${redirect.pathname} ...`);
});
