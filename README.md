# Visual Auto Review

시안 이미지와 실제 페이지를 비교하고, Chrome에서 시안 원본을 겹쳐 보며 HTML·CSS를 수정하는 검수 도구입니다.
검수 앱 v3.6.0과 Chrome 확장 v1.4.1을 포함합니다.

앱 v3.6.0은 기준 시안·실제 캡처·차이 강조를 탭으로 전환합니다.
위치 보정과 구간·캡처 정보는 화면에서 숨기고, 앱 소스 수정은 보류합니다.
차이 목록·판단 기록·통합 JSON 저장은 유지합니다.
자세한 내용은 [결과 화면 변경](docs/ui-3.6.md)을 참고하세요.

v3.5.1은 Mac 앱의 통합 JSON 저장 실패를 수정합니다.
Mac 앱에서는 저장 창에서 폴더를 선택하며, 기본 폴더는 다운로드입니다.
확장 v1.4.1은 새로고침 후 페이지에 남은 코드가 발생시키는 `Extension context invalidated` 오류를 수정합니다.

## 검수 순서

1. 검수 앱에서 프로젝트 주소, PC·MO 시안, 검수 폭을 설정합니다.
2. 검수를 실행하고 차이 항목에 상태·심각도·메모를 기록합니다.
3. **PC·MO 통합 검수 파일**을 한 번 저장합니다.
4. Chrome 확장에서 그 JSON을 한 번 불러오고 **현재 페이지에 연결** 또는 **실제 페이지 열기**를 누릅니다.
5. 화면 폭에 맞는 PC 또는 MO 시안과 해당 차이 목록이 자동으로 표시됩니다.
6. Chrome 개발자도구 Elements에서 HTML·CSS를 수정합니다.
7. 확장의 **수정한 HTML·CSS 저장**으로 내보내고 원본에 반영한 뒤 재검수합니다.

기존 검수 결과 화면과 아코디언 펼침 처리를 유지합니다.
프로젝트에서 PC 전환 폭과 각 오버레이 대상을 정합니다.
기본 전환 폭은 1024px이며, 폭은 브라우저 외곽 크기 대신 실제 페이지의 CSS 뷰포트를 기준으로 합니다.
캔버스는 검수 폭을 최소 폭으로 유지하며 화면 중앙·상단에 표시합니다.

## 이번 리팩토링

- 통합 파일에 PC·MO 원본, 선택한 비교 버전, 보정 위치, 차이 목록과 판단 기록을 함께 저장합니다.
- 확장에서는 개별 PC·MO 선택 없이 검수 묶음 하나를 연결합니다.
- 시안 누락, 불러오기, 숨김, 화면 범위 밖, 실제 표시 상태를 구분합니다.
- 시안별 위치·배율과 공통 표시 옵션은 다시 연결하거나 Chrome을 다시 실행한 뒤 복원합니다.
- 사이드패널과 개발자도구의 검수 화면은 같은 기능과 화면 코드를 사용합니다.
- 이미지와 목록 정보를 분리하고, 제한된 이미지 캐시를 사용합니다.
- 앱의 프로젝트 검증, 작업 관리, 결과 생성, 판단 이력 후보 연결을 분리했습니다.
- HTML·CSS 원본 파일명과 CSS 주석·들여쓰기·줄바꿈 보존 검사를 유지합니다.
- 전체 변경 항목과 확인 범위는 [리팩토링 기록](docs/refactoring.md)에 정리했습니다.

## 업데이트와 이전 파일

앱과 확장을 함께 갱신합니다.
실행 중인 앱은 종료한 뒤 다시 실행하고, Chrome 확장 관리에서 등록한 확장을 새로고침합니다.
개발자도구도 다시 엽니다.

| 파일 | 지원 |
| --- | --- |
| 통합 JSON v3 | 앱 3.5.0 이상 + 확장 1.4.0 이상, 한 번 불러오기로 자동 등록 |
| 시안 원본 포함 개별 JSON v2 | 확장 1.4.0에서 읽고 같은 실행·페이지의 파일을 묶음으로 변환 |
| 차이 강조 이미지 포함 JSON v1 | 앱에서 통합 파일로 다시 저장 |

확장에 저장한 기존 파일은 자동으로 저장 구조를 변환합니다.
앱의 기존 프로젝트·검수 이력은 같은 데이터 폴더에서 사용합니다.
이전 개별 파일만 사용하면 PC·MO 원본을 각각 추가해야 하므로 새 통합 파일 사용을 권장합니다.

Chrome에서는 `chrome://extensions`의 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**에서 저장소의 `chrome-extension` 폴더를 선택합니다.
이미 등록했다면 동일한 폴더를 갱신하고 새로고침합니다.
[확장 사용법](chrome-extension/사용법.md)을 참고하세요.

## Windows·macOS 실행

저장소는 소스 배포본이며 실행 환경 바이너리를 포함하지 않습니다.
Python 3.12, Node.js 22 이상, Chrome 120 이상이 필요합니다.
처음 설정할 때 라이브러리 다운로드를 위한 인터넷 연결이 필요합니다.

| 운영체제 | 처음 한 번 | 이후 실행 |
| --- | --- | --- |
| Windows | `setup-windows.cmd` | `start-windows.cmd` |
| macOS | `setup-macos.command` | `start-macos.command` |

실행 창은 열어 둔 상태로 사용하고 종료할 때 Ctrl+C를 누릅니다.
직접 실행하려면 가상 환경을 만들고 `requirements.txt`를 설치한 뒤 `python start.py`를 실행합니다.
실행 환경만 확인하려면 `python start.py --check`, 브라우저 자동 열기를 끄려면 `--no-open`을 사용합니다.

기존 macOS 앱의 실행 환경을 재사용하는 앱 빌드는 다음과 같습니다.

```sh
python build_app.py --source-app '/path/시안 검수.app' --destination '/path/새 시안 검수.app'
```

로컬 사이트 서버가 없으면 `python tools/local_site.py '/path/to/site' --port 5500`으로 실행합니다.
다른 컴퓨터에서는 그 컴퓨터의 원본 사이트와 접근 가능한 페이지 주소를 설정합니다.
개인 시안, 검수 이력, 원본 사이트는 저장소에 포함하지 않습니다.

## 데이터와 저장

- macOS: `~/Library/Application Support/VisualQA/v3`.
- Windows: `%LOCALAPPDATA%\VisualQA\v3`.
- 비교 결과는 실행·대상·비교 버전별로 보존합니다.
- Y 보정은 전체 결과를 다시 생성하고 이전 결과를 유지합니다.
- 이전 판단은 조건과 증거가 일치할 때만 이어받습니다.
  위치가 바뀐 후보는 참고 정보로 표시하며 승인을 자동 적용하지 않습니다.
- 앱 소스 편집은 보류 상태이며, 저장 전 백업과 외부 변경 충돌 검사 코드는 보존합니다.
- 확장 내보내기는 현재 DOM 사본을 저장합니다.
  원본 HTML의 구조·서식과 다를 수 있으며, 이미지·폰트·JavaScript는 원래 주소를 참조합니다.

## 코드와 검증

[전달 규격](docs/review-format.md), [생성된 JSON Schema](schema/review-package.schema.json), [시안 검수 구조](docs/refactoring.md)를 참고하세요.
`app/review-contract.json`을 수정하면 `python tools/sync_contract.py`로 확장의 규격과 Schema를 생성합니다.

가상 환경에서 실행합니다.
macOS는 `PYTHONPATH=app`, Windows PowerShell은 `$env:PYTHONPATH='app'`를 설정합니다.

```sh
python tools/sync_contract.py --check
python -m unittest discover -s tests -p 'test_*.py'
node --test tests/extension.test.mjs
python tests/chrome_handoff_integration.py
```

실제 브라우저 검사는 사용자 프로필과 분리된 Chrome for Testing을 사용합니다.
`VISUAL_QA_TEST_CHROME`에 그 실행 파일, `VISUAL_QA_TEST_PYTHON`에 가상 환경의 Python을 지정합니다.

```sh
node tests/extension_integration.mjs
node tests/extension_integration.mjs --stale-manifest
```

macOS 앱의 WebView 다운로드는 `python tests/native_download_integration.py`로 별도 검증합니다.

이전 Chrome에서 `Target.openDevTools`를 지원하지 않으면 `--legacy-devtools`를 추가합니다.
GitHub Actions에서 Windows·macOS·Linux 단위 검사와 Linux 가상 화면의 실제 Chrome 검사를 실행하도록 구성했습니다.
