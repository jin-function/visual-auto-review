# Visual Auto Review

시안 이미지와 실제 페이지를 비교하고, Chrome에서 시안 원본을 겹쳐 보며 HTML·CSS를 수정하는 검수 도구입니다.
검수 앱 소스 v3.4와 Chrome 확장 v1.3.1을 포함합니다.

## 이번 변경

- 저장하는 HTML·CSS는 원본 파일명을 유지합니다.
  동명 CSS는 파일명에 번호를 붙이지 않고 폴더로 구분합니다.
- 개발자도구의 수정된 CSS 소스를 사용해 주석·들여쓰기·줄바꿈을 보존합니다.
- HTML에서 검수 도구와 Five Server가 추가한 스크립트·스타일·마크업을 제거합니다.

- 화면 폭에 맞는 PC·MO 시안 하나만 표시합니다.
  기본 기준은 1024px이며 사이드패널에서 변경할 수 있습니다.
- 캔버스는 검수 폭을 최소 폭으로 유지하고 자동 축소하지 않습니다.
- 오버레이는 flex 중앙 정렬과 상단 정렬을 적용합니다.
  창이 좁으면 양쪽이 잘리며 시안 크기는 유지됩니다.
- 차이 목록과 관련 요소는 현재 표시 중인 시안에 맞춰 전환합니다.
  위치·배율 보정값은 시안마다 보존합니다.
- 확장 재로딩 후 남은 이전 오버레이를 정리하고 빠른 화면 전환 중 중복 표시를 방지합니다.

검수 결과 화면과 기존 아코디언 펼침 처리는 유지합니다.

## Chrome 확장만 업데이트

1. 저장소의 `chrome-extension` 폴더를 컴퓨터에 보관합니다.
2. Chrome에서 `chrome://extensions`를 열고 개발자 모드를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**에서 `chrome-extension` 폴더를 선택합니다.
4. 기존에 등록한 확장은 해당 폴더를 갱신하고 확장 관리의 새로고침을 누릅니다.
   개발자도구는 닫고 다시 엽니다.
5. 검수 파일에서 PC와 MO 파일을 각각 불러온 뒤 현재 페이지에 연결합니다.
6. 검수 옵션에서 PC·MO 시안과 전환 폭을 확인합니다.

이미 시안 원본을 포함하는 v2 검수 파일은 그대로 사용합니다.
차이 강조본이 들어 있는 v1 파일은 검수 앱에서 다시 저장해야 합니다.
확장을 새로고침하기 전에 개발자도구에서 수정한 HTML·CSS를 저장하세요.
전체 사용법은 [Chrome 확장 안내](chrome-extension/사용법.md)를 확인하세요.

## Windows·macOS에서 검수 앱 실행

이 저장소는 소스 배포본입니다.
기존 ZIP에 포함했던 Python·Node 실행 파일은 저장소에 포함하지 않습니다.
처음 한 번 아래 실행 환경을 설치합니다.

- [Python 3.12](https://www.python.org/downloads/release/python-31210/)
- [Node.js 22 이상](https://nodejs.org/en/download)
- [Chrome 120 이상](https://www.google.com/chrome/)

Windows는 Python 설치 시 Python Launcher를 함께 설치하고 Node.js 설치 후 터미널을 다시 엽니다.
처음 설정에는 라이브러리 다운로드를 위한 인터넷 연결이 필요합니다.

| 운영체제 | 처음 한 번 | 이후 실행 |
| --- | --- | --- |
| Windows | `setup-windows.cmd` | `start-windows.cmd` |
| macOS | `setup-macos.command` | `start-macos.command` |

실행하면 Chrome에 기존 검수 결과 화면이 열립니다.
실행 창은 열어 둔 상태로 사용하고 종료할 때 Ctrl+C를 누릅니다.
macOS에서 실행 권한이 없으면 터미널에서 `chmod +x *.command`를 한 번 실행합니다.

터미널에서 직접 실행할 수도 있습니다.

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python start.py
```

Windows에서는 `.venv/bin/python` 대신 `.venv\Scripts\python.exe`를 사용합니다.
실행 환경 확인은 `python start.py --check`로 진행합니다.
자동으로 브라우저를 열지 않으려면 `--no-open`을 사용합니다.

기존 macOS 앱을 사용하는 컴퓨터는 앱을 그대로 사용하고 Chrome 확장만 갱신해도 됩니다.
원본 앱의 실행 환경을 재사용하는 macOS 앱 빌드는 다음과 같습니다.

```sh
python3 build_app.py --source-app '/path/시안 검수.app' --destination '/path/새 시안 검수.app'
```

## 검수 순서

1. 검수 앱에서 프로젝트와 실제 페이지 주소를 등록합니다.
2. PC·MO 시안과 각 검수 폭을 설정하고 검수를 실행합니다.
3. 결과에서 차이 항목과 강조 화면을 확인하고 상태·심각도·메모를 저장합니다.
4. 같은 실행의 PC·MO **Chrome용 검수 파일**을 각각 저장합니다.
5. Chrome 확장 사이드패널에서 두 파일을 불러오고 실제 페이지를 엽니다.
   같은 실행·페이지의 시안은 자동 연결합니다.
   다른 실행의 시안은 옵션에서 직접 짝을 지정합니다.
6. 실제 페이지의 개발자도구 Elements에서 HTML·CSS를 수정합니다.
7. 사이드패널의 **수정한 HTML·CSS 저장**으로 내보내고 원본에 반영합니다.
8. 새 검수를 실행해 변경 결과를 확인합니다.

검수 파일·실제 페이지 URL이 같은 경우에만 연결합니다.
현재 폭에 맞는 시안이 없으면 오버레이를 숨기고 파일 등록을 안내합니다.
사이트의 반응형 기준에 맞춰 **PC 전환 폭**을 설정하세요.

로컬 사이트를 열려면 기존 개발 서버를 사용하거나 아래 도구를 사용합니다.

```sh
python tools/local_site.py '/path/to/site' --port 5500
```

루트 경로가 `/kr/...`인 사이트는 `kr` 폴더의 상위 폴더를 서버 루트로 지정합니다.
다른 PC에서는 해당 PC의 원본 사이트와 접근 가능한 페이지 주소를 다시 연결합니다.
개인 시안, 검수 이력, 사이트 원본은 저장소에 포함하지 않습니다.

## 저장과 비교

- macOS 저장 위치: `~/Library/Application Support/VisualQA/v3`.
- Windows 저장 위치: `%LOCALAPPDATA%\VisualQA\v3`.
- 전체 영역과 누락·추가 영역을 비교하고 모든 화면·보고서가 하나의 계산 결과를 사용합니다.
- Y 보정은 전체 비교 결과를 새 버전으로 생성하며 보정 전 결과도 보존합니다.
- 기존 실행을 삭제하지 않고 완료한 새 결과를 등록합니다.
  이력 정리는 별도 기능입니다.
- 전체 차이율은 참고 지표이며 차이 항목별 판단·심각도를 저장합니다.
- 소스 편집 기능은 원본 저장 전 백업과 외부 편집 충돌 검사를 제공합니다.
- 원래 아코디언 펼침 본문은 `app/page_state.js`에 보존했습니다.

## 소스 구성

| 경로 | 역할 |
| --- | --- |
| `start.py` | Windows·macOS 공통 실행 |
| `app/qa/engine.py` | 비교·구간 수치·차이 항목·이미지 생성 |
| `app/qa/capture.py`, `app/capture_page.js` | 브라우저 캡처와 진단 |
| `app/qa/storage.py`, `app/qa/service.py` | 이력·결과·보정·작업 관리 |
| `app/qa/source.py` | 원본 연결·편집·백업·복원 |
| `app/qa/chrome_review.py` | 시안 원본과 차이 항목 전달 |
| `app/web/` | 기존 검수 화면 |
| `app/profiles.json` | 페이지별 캡처 설정 |
| `chrome-extension/responsive.mjs` | PC·MO 분기와 자동 짝 연결 |
| `chrome-extension/overlay-layout.js`, `content.js` | 캔버스 크기·중앙 정렬·표시 |
| `chrome-extension/sidepanel.js`, `toolbar.js` | 검수 옵션·차이 목록 |
| `native/VisualQALauncher.swift` | 기존 macOS 앱 실행기 |

## 검증

가상 환경을 활성화한 뒤 저장소 루트에서 실행합니다.

```sh
python -m unittest discover -s tests -p 'test_*.py'
node --test tests/extension.test.mjs
```

Python 검사는 `app` 모듈 경로가 필요합니다.
macOS는 `PYTHONPATH=app`, Windows PowerShell은 `$env:PYTHONPATH='app'`를 설정합니다.

Chrome 통합 검사는 일반 사용자 Chrome과 별개의 임시 프로필을 사용합니다.
`VISUAL_QA_TEST_CHROME`에 Chrome for Testing 실행 파일의 전체 경로를 지정한 뒤 실행합니다.

```sh
node tests/extension_integration.mjs
node tests/extension_integration.mjs --stale-manifest
```

검증 범위와 확인이 남은 사항은 [v1.3.1 저장 검증 기록](verification/extension-1.3.1.md)에 정리했습니다.
