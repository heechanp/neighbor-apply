// ===== 서로이웃 자동 신청 (Aside) =====
// make_apply_scripts.py가 만든 apply_fill.ps1이 맨 앞에 DATA를 붙여 apply_run.js로 실행한다.
//   DATA = { myId, myNick, group, gapMin, gapMax, items: [{ blogId, nick, message }], doneKeys: [...] }
// 규칙
//  - 시작할 때 Aside에 로그인된 계정이 DATA.myId인지 확인. 다르면 'APPLY_ACCOUNT_MISMATCH <지금 계정>'만 찍고 끝.
//  - 한 번 실행은 TIME_BUDGET초 안에서 끝내고 'APPLY_REMAINING n' 출력 → ps1이 0이 될 때까지 다시 실행.
//  - 처리한 사람(성공·건너뜀)은 'a:<myId>:<blogId>' 키로 DONE_KEYS에 넣는다 → 다시 안 봄.
//  - 하루 신청 제한·자동입력 방지 문구가 뜨면 바로 멈추고 'APPLY_LIMIT ...' 출력(다음 사람 안 엶).
//  - 메시지가 그대로 들어갔는지 확인한 뒤에만 '확인'을 누른다.
const ME_ID = DATA.myId;
const GROUP = DATA.group || '기타';
const TIME_BUDGET = 85;
const GAP_MIN = DATA.gapMin || 8, GAP_MAX = DATA.gapMax || 15;
const out = { results: [], step: [] };
const doneNow = [];
const t0 = Date.now();
const sec = () => (Date.now() - t0) / 1000;
const log = (s) => out.step.push(`${sec().toFixed(1)}s ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) {} await wait(300); } return null; };
const keyOf = (it) => `a:${ME_ID}:${it.blogId}`;

// 네이버 알림 문구 판정 (처음 몇 번 실제 문구를 보고 고친다)
const LIMIT_RE = /(하루|1일|일일|오늘).{0,30}(신청|추가).{0,30}(초과|제한|한도|최대|없습니다|수\s*있)|(신청|추가).{0,20}(초과|한도|제한)|더\s*이상.{0,20}(신청|추가)/;
const CAPTCHA_RE = /자동\s*입력\s*방지|보안\s*문자|captcha/i;
const ALREADY_RE = /이미.{0,20}(이웃|신청|서로이웃)|신청\s*(진행\s*)?중|수락\s*대기/;
// 2026-11-19 확인: 신청이 되면 알림 없이 그대로 있고, 신청 화면을 다시 열면 이 문구가 나온다
const PENDING_RE = /서로이웃\s*신청\s*진행\s*중/;
const NOBOTH_RE = /서로이웃.{0,20}(받지|허용하지|불가|할 수 없)/;
const SELF_RE = /나\s*자신/;
const OK_RE = /(신청|추가).{0,15}(되었|됐|완료|보냈|하였)|(보냈습니다|완료되었습니다)/;
const GROUP_FULL_RE = /그룹.{0,30}(초과|가득|꽉|최대|더\s*이상|인원)/;

let page = null;
const ev = (fn, arg) => page.mainFrame().evaluate(fn, arg);
const HOOK = "(function(){if(window.__asideHooked)return;window.__asideHooked=1;var k=function(m){var a=document.documentElement;a.setAttribute('data-aside-alert',(a.getAttribute('data-aside-alert')||'')+'|'+String(m));return true;};window.alert=k;window.confirm=k;})();";
const hookAlerts = () => ev((h) => { const s = document.createElement('script'); s.textContent = h; (document.head || document.documentElement).appendChild(s); }, HOOK).catch(() => {});
const alertText = () => ev(() => document.documentElement.getAttribute('data-aside-alert') || '').catch(() => '');
const bodyText = () => ev(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
const rectOf = (sel) => ev((sel) => {
  const e = document.querySelector(sel); if (!e) return null;
  e.scrollIntoView({ block: 'center' });
  const r = e.getBoundingClientRect(); if (!r.width && !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, sel);
const clickSel = async (sel) => { const r = await rectOf(sel); if (!r) return false; await wait(200); await page.mouse.click(r.x, r.y); return true; };

const typeText = async (s) => {
  if (page.keyboard.sendCharacter) { try { await page.keyboard.sendCharacter(s); return; } catch (e) {} }
  const ok = await ev((s) => { try { return document.execCommand('insertText', false, s); } catch (e) { return false; } }, s);
  if (!ok) await page.keyboard.type(s, { delay: 30 });
};

const checkAccount = async () => {
  page = await openTab('https://blog.naver.com/MyBlog.naver');
  if (page.evaluateOnNewDocument) { try { await page.evaluateOnNewDocument(HOOK); } catch (e) {} }
  const id = await until(() => { const m = page.url().match(/blog\.naver\.com\/([A-Za-z0-9_-]+)\/?(\?|$)/); return m && m[1] !== 'MyBlog.naver' ? m[1] : null; }, 12000);
  if (/nid\.naver\.com/.test(page.url())) return 'NOT_LOGGED_IN';
  return id || 'UNKNOWN';
};

const applyOne = async (it) => {
  const r = { blogId: it.blogId, nick: it.nick, status: '', msg: '' };
  await page.goto(`https://m.blog.naver.com/BuddyAddForm.naver?blogId=${it.blogId}`);
  await hookAlerts();
  const state = await until(() => ev(() => {
    if (document.querySelector('#bothBuddyRadio')) return 'form';
    const t = document.body ? document.body.innerText : '';
    return t.length > 20 && !/로딩/.test(t) ? 'text' : null;
  }), 12000);
  await wait(500);
  const pre = (await alertText()) + ' ' + (await bodyText());
  if (CAPTCHA_RE.test(pre)) return { ...r, status: 'limit', msg: pre.slice(0, 150) };
  if (state !== 'form') {
    r.msg = pre.slice(0, 150);
    if (SELF_RE.test(pre)) r.status = 'skip_self';
    else if (ALREADY_RE.test(pre)) r.status = 'skip_already';
    else if (LIMIT_RE.test(pre)) r.status = 'limit';
    else r.status = 'skip_noform';
    return r;
  }
  const bothOff = await ev(() => { const e = document.querySelector('#bothBuddyRadio'); return e.disabled || e.getAttribute('disabled') !== null; });
  if (bothOff) return { ...r, status: 'skip_noboth', msg: '서로이웃 선택이 막힘' };
  if (!(await clickSel('label[for="bothBuddyRadio"]'))) await clickSel('#bothBuddyRadio');
  const shown = await until(() => ev(() => { const t = document.querySelector('textarea'); return document.querySelector('#bothBuddyRadio').checked && t && (t.offsetWidth || t.offsetHeight); }), 5000);
  if (!shown) return { ...r, status: 'fail', msg: '서로이웃 선택 안 됨' };
  // 그룹
  const g = await ev((name) => {
    const s = document.querySelector('#buddyGroupSelect'); if (!s) return 'nogroup';
    const opts = [...s.options];
    // '<이름>', '<이름> 2', '<이름> 3' … 중 번호가 가장 큰 그룹(꽉 차서 새로 만든 그룹)을 쓴다
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + esc + '(?: (\\d+))?$');
    const cand = opts.map((o) => [o, re.exec(o.text.trim())]).filter((x) => x[1]).sort((a, b) => (+(a[1][1] || 1)) - (+(b[1][1] || 1)));
    const o = cand.length ? cand[cand.length - 1][0] : opts[opts.length - 1];
    if (!o) return 'nogroup';
    s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true }));
    return o.text.trim();
  }, GROUP);
  log(`${it.blogId} 그룹 ${g}`);
  // 메시지
  await clickSel('textarea');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace'); await wait(200);
  await typeText(it.message);
  await wait(300);
  const val = await ev(() => (document.querySelector('textarea') || {}).value || '');
  if (val.trim() !== it.message.trim()) return { ...r, status: 'fail', msg: '메시지가 다르게 들어감: ' + val.slice(0, 60) };
  // 시험 모드: 다 채우고 '확인'은 누르지 않는다
  if (DATA.dryRun) return { ...r, status: 'dry', msg: `그룹 ${g} / 메시지 들어감` };
  // 확인
  await ev(() => document.documentElement.removeAttribute('data-aside-alert'));
  await hookAlerts();
  if (!(await clickSel('a.btn_ok'))) return { ...r, status: 'fail', msg: '확인 버튼 없음' };
  const after = await until(async () => {
    const a = await alertText(); if (a) return a;
    if (!/BuddyAddForm/.test(page.url())) return 'URL ' + page.url();
    return null;
  }, 5000);
  await wait(500);
  let post = ((after || '') + ' ' + (await alertText())).trim();
  if (!after) {
    // 알림이 없으면 '보낸신청' 목록에 그 사람이 있는지 본다.
    // (신청 화면을 다시 열면 "신청 진행중입니다. 취소하시겠습니까?" 창이 떠서 쓰지 않는다 — 2026-11-20 사용자)
    await page.goto(`https://admin.blog.naver.com/BuddyInviteSentManage.naver?blogId=${ME_ID}`);
    const listed = await until(() => ev((id) => {
      const t = document.body ? document.body.innerText : '';
      if (!/보낸신청/.test(t)) return null;
      return new RegExp('(^|\\s)' + id.replace(/[-]/g, '\\-') + '(\\s|$)').test(t) ? 'yes' : 'no';
    }, it.blogId), 8000);
    if (listed === 'yes') return { ...r, status: 'ok', msg: '보낸신청 목록에서 확인' };
    post = '보낸신청 목록에 없음';
  }
  r.msg = post.slice(0, 150) || '(알림 없음)';
  if (GROUP_FULL_RE.test(post)) r.status = 'group_full';
  else if (CAPTCHA_RE.test(post) || LIMIT_RE.test(post)) r.status = 'limit';
  else if (ALREADY_RE.test(post)) r.status = 'skip_already';
  else if (NOBOTH_RE.test(post)) r.status = 'skip_noboth';
  else if (OK_RE.test(post) || /^URL /.test(after || '')) r.status = 'ok';
  else r.status = 'unknown';
  return r;
};

// 그룹이 꽉 차면 관리 화면에서 새 그룹('<기본그룹 이름> 2', 3 …)을 만든다 (2026-11-19 사용자: 꽉 차면 새 그룹 만들어 이어서)
const addGroup = async () => {
  await page.goto(`https://admin.blog.naver.com/BuddyGroupManage.naver?blogId=${ME_ID}`);
  await until(() => ev(() => !!document.querySelector('#addGroupForm input[name="name"]')), 12000);
  const names = await ev(() => document.body.innerText);
  let n = 2; while (names.includes(`${GROUP} ${n}`)) n++;
  const name = `${GROUP} ${n}`;
  await ev(() => { const s = document.createElement('script'); s.textContent = "window.alert=function(){return true};window.confirm=function(){return true};"; document.head.appendChild(s); });
  await ev((name) => { const f = document.querySelector('#addGroupForm'); f.querySelector('input[name="name"]').onfocus = null; f.querySelector('input[name="name"]').value = name; f.submit(); }, name);
  await wait(3000);
  await page.goto(`https://admin.blog.naver.com/BuddyGroupManage.naver?blogId=${ME_ID}`);
  await wait(2000);
  const ok = (await ev(() => document.body.innerText)).includes(name);
  log(`새 그룹 ${name} ${ok ? '만듦' : '못 만듦'}`);
  return ok ? name : null;
};

try {
  const cur = await checkAccount();
  if (cur !== ME_ID) {
    console.log('APPLY_ACCOUNT_MISMATCH ' + cur);
  } else {
    log('계정 확인 ' + cur);
    const doneSet = new Set(DATA.doneKeys || []);
    const todo = DATA.items.filter((it) => !doneSet.has(keyOf(it)));
    let limit = null, n = 0;
    for (const it of todo) {
      if (sec() > TIME_BUDGET) break;
      let r = await applyOne(it);
      if (r.status === 'group_full') {
        const g = await addGroup();
        if (!g) { r.status = 'limit'; r.msg = '그룹이 꽉 찼는데 새 그룹을 못 만듦: ' + r.msg; }
        else { console.log('APPLY_NEW_GROUP ' + g); r = await applyOne(it); }
      }
      out.results.push(r);
      log(`${it.blogId} ${r.status} ${r.msg}`);
      if (r.status === 'limit') { limit = r.msg; break; }
      // 성공·건너뜀·알 수 없음(두 번 신청하지 않게)은 처리한 것으로 친다. fail만 다음에 다시.
      if (r.status !== 'fail' && r.status !== 'dry') doneNow.push(keyOf(it));
      n++;
      if (r.status === 'ok' || r.status === 'unknown') await wait(1000 * (GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN)));
      else await wait(1500);
    }
    // 이번에 아직 못 본 사람 수 (실패한 사람은 다음 라운드에서 한 번 더 시도된다)
    const remaining = todo.length - out.results.length;
    console.log('DONE_KEYS ' + JSON.stringify(doneNow));
    out.results.forEach((r) => console.log('RESULT ' + JSON.stringify(r)));
    if (limit) console.log('APPLY_LIMIT ' + limit);
    console.log('APPLY_REMAINING ' + Math.max(0, remaining));
  }
} catch (e) {
  console.log('APPLY_ERROR ' + (e && e.message));
  console.log('DONE_KEYS ' + JSON.stringify(doneNow));
  out.results.forEach((r) => console.log('RESULT ' + JSON.stringify(r)));
}
console.log('STEPS ' + JSON.stringify(out.step));
if (page) { try { await page.close(); } catch (e) {} }
