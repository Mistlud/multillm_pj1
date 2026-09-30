import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const lock = join(config.dataDir, 'server-lock.json');
if (existsSync(lock)) {
  const previous = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
  let alive = true;
  try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
  if (alive) throw new Error('이 데이터 폴더의 서버가 이미 실행 중입니다.');
  unlinkSync(lock);
}
writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
const release = () => { if (existsSync(lock) && JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock); };
process.once('exit', release);
const app = createApp(config);
app.server.once('error', (error) => { console.error(`서버 시작 실패: ${(error as NodeJS.ErrnoException).code ?? 'error'}`); app.workers.stop(); app.store.close(); release(); process.exitCode = 1; });
app.server.listen(config.port, config.host, () => {
  app.startWorkers();
  console.log(`LLM 단톡방: http://localhost:${config.port}`);
  console.log(`접속 토큰 파일: ${join(config.dataDir, 'access-token.txt')}`);
  console.log('종료: Ctrl+C 또는 관리 화면의 서버 종료');
});
process.once('SIGINT', app.shutdown);
process.once('SIGTERM', app.shutdown);
