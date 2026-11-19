"""주제(검색어)로 네이버 블로그 글 검색 → 서로이웃 신청할 사람 모으기 (로그인 없이 공개 정보만)

  python search_posts.py --account qlgovl_ --keyword "경제" --count 30 --out <작업폴더>
     [--keyword 재테크 ...]  여러 번 주면 인원을 나눠 모음
     [--order recentdate|sim]  기본 최신순
     [--keep-biz]  업체·홍보 같은 이름도 포함

- 블로그 주소 기준 한 사람당 글 하나.
- 내 계정, 예전에 이 계정으로 신청·처리한 사람(작업폴더의 부모 폴더 아래 */apply_done.json)은 건너뜀.
- 결과: <작업폴더>/candidates.json, cand_part1.json ... (30명씩)
"""
import argparse
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
MY_IDS = {'qlgovl_', 'heechan0688'}
BIZ = re.compile(r'부동산|세무|법무|변호|보청기|의원|병원|한의원|치과|인테리어|청소|누수|대출|사채|요양|컴퍼니|센터|공인중개|보험|렌탈|분양|마케팅|광고|학원|코칭|상담|에어컨|이사|철거|시공|설비|리딩|투자자문|코인방|주식방|공식|official', re.I)
DROP_LINE = re.compile(r'주소|영업\s*시간|전화|주차|협찬|원고료|제공받|#|https?://|^\s*$')


def get(url, ua, ref=None, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': ua, **({'Referer': ref} if ref else {})})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read().decode('utf-8', 'replace')
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(1.5 * (k + 1))


def strip_tags(s):
    return html.unescape(re.sub(r'<[^>]+>', '', s or '')).strip()


def search(keyword, page, order):
    q = urllib.parse.urlencode({'countPerPage': 7, 'currentPage': page, 'endDate': '', 'keyword': keyword,
                                'orderBy': order, 'startDate': '', 'type': 'post'})
    t = get('https://section.blog.naver.com/ajax/SearchList.naver?' + q, UA_PC,
            'https://section.blog.naver.com/Search/Post.naver?keyword=' + urllib.parse.quote(keyword))
    j = json.loads(t[t.index('{'):])
    return (j.get('result') or {}).get('searchList') or []


def body(blog_id, log_no):
    try:
        t = get(f'https://m.blog.naver.com/PostView.naver?blogId={blog_id}&logNo={log_no}', UA_M)
    except Exception:
        return ''
    paras = re.findall(r'<p class="se-text-paragraph[^"]*"[^>]*>(.*?)</p>', t, re.S)
    lines = [strip_tags(p).replace('​', '') for p in paras]
    lines = [l for l in lines if l and not DROP_LINE.search(l)]
    text = '\n'.join(lines)
    if len(text) > 900:
        text = text[:500] + '\n…(중략)…\n' + text[-300:]
    return text


def history(out):
    done = set()
    for f in out.parent.glob('*/apply_done.json'):
        try:
            for k in json.loads(f.read_text(encoding='utf-8')):
                done.add(k)
        except Exception:
            pass
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--account', required=True)
    ap.add_argument('--keyword', action='append', required=True)
    ap.add_argument('--count', type=int, default=30)
    ap.add_argument('--order', default='recentdate')
    ap.add_argument('--keep-biz', action='store_true')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    done = history(out)
    seen = set(MY_IDS)
    skipped = {'예전에 처리함': 0, '업체·홍보 이름': 0, '본문 없음': 0}
    picked = []
    per_kw = -(-a.count // len(a.keyword))
    for kw in a.keyword:
        got, page = 0, 1
        while got < per_kw and page <= 40:
            rows = search(kw, page, a.order)
            if not rows:
                break
            cands = []
            for r in rows:
                bid = r.get('domainIdOrBlogId') or ''
                if not bid or bid in seen:
                    continue
                seen.add(bid)
                if f'a:{a.account}:{bid}' in done:
                    skipped['예전에 처리함'] += 1
                    continue
                nick, bname = r.get('nickName') or '', r.get('blogName') or ''
                if not a.keep_biz and (BIZ.search(nick) or BIZ.search(bname)):
                    skipped['업체·홍보 이름'] += 1
                    continue
                cands.append({'nick': nick, 'blogId': bid, 'blogName': bname, 'logNo': str(r.get('logNo')),
                              'title': strip_tags(r.get('title')), 'keyword': kw,
                              'date': time.strftime('%Y-%m-%d', time.localtime((r.get('addDate') or 0) / 1000)),
                              'summary': strip_tags(r.get('contents'))})
            with ThreadPoolExecutor(6) as ex:
                texts = list(ex.map(lambda c: body(c['blogId'], c['logNo']), cands))
            for c, t in zip(cands, texts):
                if got >= per_kw:
                    break
                c['text'] = t or c['summary']
                if len(c['text']) < 60:
                    skipped['본문 없음'] += 1
                    continue
                c.pop('summary')
                picked.append(c)
                got += 1
            page += 1
            time.sleep(0.5)
        print(f'[{kw}] {got}명 ({page - 1}쪽까지 봄)')
    picked = picked[:a.count]
    (out / 'candidates.json').write_text(json.dumps({'account': a.account, 'keywords': a.keyword, 'skipped': skipped,
                                                      'candidates': picked}, ensure_ascii=False, indent=1), encoding='utf-8')
    for i in range(0, len(picked), 30):
        (out / f'cand_part{i // 30 + 1}.json').write_text(
            '[\n' + ',\n'.join(json.dumps(c, ensure_ascii=False) for c in picked[i:i + 30]) + '\n]', encoding='utf-8')
    print(f'저장: {out / "candidates.json"} ({len(picked)}명). 건너뜀: {skipped}')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
