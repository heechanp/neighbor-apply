"""plan.json(신청 메시지 목록) → Aside 실행 파일 만들기

  python make_apply_scripts.py <작업폴더>/plan.json [--dry]
  --dry: 시험 모드. 신청 화면을 다 채우고 '확인'은 누르지 않는다(apply_done.json에도 안 남김)

만드는 것 (plan.json과 같은 폴더):
  apply_engine.js   Aside가 실행할 코드 (DATA는 실행 때마다 apply_fill.ps1이 앞에 붙인다)
  apply_data.json   할 일 목록
  apply_fill.ps1    'APPLY_REMAINING 0'이 될 때까지 Aside 반복 실행. 처리한 사람은 apply_done.json에 모은다
                    (중간에 멈춰도 다시 실행하면 이어서 한다. search_posts.py도 이 파일로 예전 사람을 거른다)
종료 코드: 0 다 함 / 1 멈춤(로그 확인) / 2 네이버 제한 / 3 Aside 계정이 다름
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

PS1 = r"""# 서로이웃 자동 신청 (Aside). 이 파일이 있는 폴더에서 실행.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'apply_log.txt'
$doneFile = Join-Path $here 'apply_done.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path $doneFile)) { [IO.File]::WriteAllText($doneFile, '[]', $utf8) }
$engine = [IO.File]::ReadAllText((Join-Path $here 'apply_engine.js'), [Text.Encoding]::UTF8)
$data = [IO.File]::ReadAllText((Join-Path $here 'apply_data.json'), [Text.Encoding]::UTF8)
$tmp = Join-Path $here 'apply_run.js'
for ($i = 1; $i -le 60; $i++) {
  $done = [IO.File]::ReadAllText($doneFile, [Text.Encoding]::UTF8)
  $js = 'const DATA = ' + $data.TrimEnd().TrimEnd('}') + ',"doneKeys":' + $done + "};`n" + $engine
  [IO.File]::WriteAllText($tmp, $js, $utf8)
  Write-Host "[round $i] ..."
  $o = aside repl --file $tmp 2>&1 | ForEach-Object { "$_" } | Out-String
  $o | Out-File $log -Append -Encoding utf8
  Write-Host $o
  if ($o -match 'APPLY_ACCOUNT_MISMATCH (\S+)') {
    Write-Host ('ACCOUNT MISMATCH. Aside에 로그인된 계정: ' + $Matches[1])
    exit 3
  }
  if ($o -match 'DONE_KEYS (\[.*\])') {
    $keys = @([regex]::Matches($done + ' ' + $Matches[1], 'a:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+') | ForEach-Object { $_.Value } | Select-Object -Unique)
    $json = if ($keys.Count) { '["' + ($keys -join '","') + '"]' } else { '[]' }
    [IO.File]::WriteAllText($doneFile, $json, $utf8)
  }
  if ($o -match 'APPLY_LIMIT (.*)') {
    Write-Host ('LIMIT STOP. 네이버 신청 제한(또는 자동입력 방지): ' + $Matches[1])
    exit 2
  }
  if ($o -match 'APPLY_REMAINING (\d+)') {
    if ([int]$Matches[1] -eq 0) { Write-Host 'ALL DONE. 결과는 apply_log.txt 의 RESULT 줄'; exit 0 }
  } else { Write-Host 'STOPPED. apply_log.txt 를 확인하세요'; exit 1 }
}
Write-Host '60회 반복 후에도 남음. apply_log.txt 확인'
exit 1
"""


def main():
    plan_path = Path(sys.argv[1])
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    seen, items = set(), []
    for it in plan.get('items', []):
        msg = (it.get('message') or '').replace('\r', ' ').replace('\n', ' ').strip()
        if msg and it['blogId'] not in seen:
            seen.add(it['blogId'])
            items.append({'blogId': it['blogId'], 'nick': it.get('nick', ''), 'message': msg})
    out = plan_path.parent
    # 간격(초)은 settings.md 기준. plan.json에 gapMin/gapMax가 있으면 그 값을 쓴다.
    data = {'myId': plan['myId'], 'myNick': plan.get('myNick', ''), 'group': plan.get('group', '기타'),
            'gapMin': plan.get('gapMin', 8), 'gapMax': plan.get('gapMax', 15), 'items': items}
    if '--dry' in sys.argv:  # 시험: 신청 화면을 채우기만 하고 '확인'은 누르지 않음
        data.update(dryRun=True, gapMin=1, gapMax=1)
    (out / 'apply_data.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    (out / 'apply_engine.js').write_text((HERE / 'aside' / 'engine_apply.js').read_text(encoding='utf-8'), encoding='utf-8')
    (out / 'apply_fill.ps1').write_text(PS1, encoding='utf-8-sig')
    print(f"{plan['myId']} 계정으로 {len(items)}명 신청 준비")
    print(f"실행: powershell -NoProfile -ExecutionPolicy Bypass -File \"{out / 'apply_fill.ps1'}\"")


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
