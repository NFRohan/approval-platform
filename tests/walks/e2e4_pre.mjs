// Stage 4 walk: a real mail server (Mailpit in Docker) receives what the app sends.
import { execFileSync } from 'node:child_process';
const MAILPIT = 'approval-platform-mailpit';
const dk = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try { dk('rm', '-f', MAILPIT); } catch {}
dk('run', '-d', '--name', MAILPIT, '-p', '127.0.0.1::1025', '-p', '127.0.0.1::8025', 'public.ecr.aws/supabase/mailpit:v1.30.2');
const smtpPort = dk('port', MAILPIT, '1025/tcp').split('\n')[0].split(':').pop();
const apiPort = dk('port', MAILPIT, '8025/tcp').split('\n')[0].split(':').pop();
const MAILAPI = `http://127.0.0.1:${apiPort}/api/v1`;
for (let i = 0; i < 40; i++) { try { if ((await fetch(MAILAPI + '/messages')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
process.env.SMTP_URL = `smtp://127.0.0.1:${smtpPort}`;
process.env.MAIL_FROM = 'Approvals <approvals@example.com>';
process.env.APP_URL = 'https://app.test';
process.env.CRON_SECRET = 'cron-secret-for-the-walk-0123456789';
const mailbox = async () => (await (await fetch(MAILAPI + '/messages?limit=200')).json()).messages ?? [];
const stopMailpit = () => { try { dk('rm', '-f', MAILPIT); } catch {} };
