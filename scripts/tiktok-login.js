#!/usr/bin/env node
// TikTok login via agent-browser. Session persists in --session, so a CAPTCHA solved once (--headed) is reused.
// Env: TIKTOK_USERNAME, TIKTOK_PASSWORD, TIKTOK_SESSION_NAME, TIKTOK_COOKIES_OUTPUT. Flag: --headed.
// Exit: 0 logged in, 1 error/missing creds, 2 challenge (CAPTCHA/2FA) needs a human.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SESSION = process.env.TIKTOK_SESSION_NAME || 'tiktok-session';
const { TIKTOK_USERNAME: USER, TIKTOK_PASSWORD: PASS } = process.env;
const HEADED = process.argv.includes('--headed');
const OUT = process.env.TIKTOK_COOKIES_OUTPUT || path.join(process.cwd(), 'tiktok-cookies.json');
const LOGIN_URL = 'https://www.tiktok.com/login/phone-or-email/email';

// No shell: args go straight to argv, so credentials cannot inject commands.
const ab = (args, input) => {
	try {
		return execFileSync('agent-browser', ['--session', SESSION, ...args], {
			encoding: 'utf8',
			input,
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();
	} catch (err) {
		return `${err.stdout ?? ''}${err.stderr ?? ''}`;
	}
};

const cookies = () => {
	try {
		return JSON.parse(ab(['cookies', '--json']))?.data?.cookies ?? [];
	} catch {
		return [];
	}
};

const done = (status, extra = {}, code = 0) => {
	console.log(JSON.stringify({ status, ...extra }));
	process.exit(code);
};

const saveIfLoggedIn = (status) => {
	const all = cookies();
	if (!all.some((c) => c.name === 'sessionid' && c.value)) return;
	fs.writeFileSync(OUT, JSON.stringify(all, null, 2), { mode: 0o600 }); // session cookie = account access
	done(status, { cookiesFile: OUT });
};

ab(['open', LOGIN_URL, ...(HEADED ? ['--headed'] : [])]);
ab(['wait', '3000']);
saveIfLoggedIn('already_authenticated');

if (!USER || !PASS) done('needs_credentials', { hint: 'Set TIKTOK_USERNAME and TIKTOK_PASSWORD' }, 1);

// Password goes over stdin to the agent-browser vault, never into argv / `ps`.
ab(['auth', 'save', 'tiktok', '--url', LOGIN_URL, '--username', USER, '--password-stdin'], PASS);
ab([
	'auth', 'login', 'tiktok', '--no-navigate',
	'--username-selector', 'input[name="username"]',
	'--password-selector', 'input[type="password"]',
]);
ab(['click', 'button[type="submit"]']);
ab(['wait', HEADED ? '30000' : '8000']); // headed: time for a human to solve the slide puzzle

saveIfLoggedIn('success');
done('challenge_required', { hint: 'Run once with --headed and solve the CAPTCHA: node scripts/tiktok-login.js --headed' }, 2);
