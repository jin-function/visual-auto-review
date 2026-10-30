# Chrome 확장 v1.3.1 저장 검증

환경: macOS Intel, Node 22.21.0, Chrome for Testing 149.0.7827.55.
별도 임시 Chrome 프로필과 샘플 페이지로 확인했습니다.

## 확인한 문제와 변경

- CSS 파일명에 붙이던 번호·해시를 제거했습니다.
  원본 이름을 유지하며 동명 파일은 별도 폴더로 구분합니다.
- CSSOM 전체 직렬화를 우선하던 저장 방식 대신 개발자도구의 수정된 소스 텍스트를 사용합니다.
  원본 주석·들여쓰기·줄바꿈을 보존하며 URL 값만 저장 경로에 맞춥니다.
- 소스에 없는 런타임 규칙을 반영하고 저장 전 현재 CSS 규칙과 순서가 일치하는지 확인합니다.
- HTML 사본에서 검수 도구와 Five Server의 주입 내용을 제거합니다.
  원본 페이지와 개발자도구의 수정 내용은 변경하지 않습니다.

## 검증 결과

- 확장 단위 검사 13개 통과.
- Chrome 통합 흐름 54개 통과.
- 실제 ZIP 내부의 HTML·CSS 파일명과 파일 내용을 확인했습니다.
- 16,000개 규칙·1,145,780자 CSS를 원본과 같은 텍스트로 저장했습니다.
  이 환경에서 내보내기 생성에 약 1.7초가 걸렸습니다.
- CRLF와 LF, 공백과 탭 들여쓰기, 주석, URL 안의 줄바꿈과 따옴표 보존을 확인했습니다.
- 이름이 같은 서로 다른 출처의 CSS를 별도 폴더에 저장하고 HTML 연결 경로를 확인했습니다.
- 검수용 script·style·마크업, Five Server script·강조 스타일·안내 마크업·주입 주석, 도구의 adopted stylesheet 제거를 확인했습니다.
- 페이지 자체의 JSON-LD 스크립트와 인라인 스타일은 보존됩니다.
- 기존 PC·MO 전환, 오버레이, 요소 선택과 수정본 저장 흐름도 통과했습니다.

## 실행

```sh
node --test tests/extension.test.mjs
node tests/extension_integration.mjs
node tests/extension_integration.mjs --benchmark-css
```

통합 검사는 `VISUAL_QA_TEST_CHROME`에 Chrome for Testing 실행 파일 경로를 지정합니다.
사용 중인 일반 Chrome 프로필은 사용하지 않습니다.

CSS 수집에는 [Chrome 개발자도구의 원본 리소스 조회 기능](https://developer.chrome.com/docs/extensions/reference/api/devtools/inspectedWindow)을 사용합니다.
소스 텍스트를 제공하지 않는 동적 CSS에는 원본 파일의 서식을 복원할 수 없으므로 저장 알림에 기록합니다.
