# Chrome 확장 v1.3.0 검증

검증일: 2026-10-30.
환경: macOS Intel, Python 3.12.6, Node 22.21.0, Chrome for Testing 149.0.7827.55.
일반 사용자 프로필과 검수 자료는 수정하지 않고 임시 프로필·저장소·샘플 페이지로 확인했습니다.

## 결과

- Python 단위 검사 42개 통과.
- 확장 단위 검사 10개 통과.
- Chrome 통합 흐름 45개 통과.
- 이전 권한 상태에서의 사이드패널 안내·확장 버전 표시·확장 관리 이동 4개 통과.
- 공통 실행기의 실제 캡처·비교·보정·검수 메모·보고서 저장·Chrome용 파일 전달 통과.
- 기존 아코디언 모듈 본문 해시 보존 검사 통과.

## 이번 변경의 확인 항목

| 항목 | 확인 결과 |
| --- | --- |
| 기본 분기 | 1023px은 MO, 1024px은 PC |
| 사용자 지정 분기 | 769px으로 변경 후 768px·769px 양쪽 확인 |
| PC 캔버스 최소 폭 | 1200px 화면에서도 1920px 캔버스 유지 |
| 중앙 배치 | 1920px 캔버스의 왼쪽 위치 -360px 확인 |
| 넓은 화면 | 2560px 화면에서 원래 표시 크기 유지·중앙 배치 |
| MO 캔버스 최소 폭 | 320px 화면에서도 등록된 검수 폭 유지 |
| DOM·레이아웃 | 페이지의 HTML·body 스타일, 요소 배치와 페이지 높이 유지 |
| 중복 방지 | 남아 있던 이전 오버레이 제거·빠른 크기 변경 후 캔버스 하나 유지 |
| 시안 누락 | 현재 기기에 맞는 시안이 없으면 반대 기기 시안을 숨김 |
| 차이 목록 | PC·MO 전환 시 해당 시안의 차이 항목·선택자 목록으로 교체 |
| 보정값 | PC의 X 보정이 MO에 적용되지 않고 PC 복귀 시 복원 |
| 기존 기능 | 요소 선택·HTML/CSS 수정·내보내기·사이드패널 닫기와 재열기 확인 |
| 긴 시안 | 원본 716×32768px 이미지 전달·표시 확인 |

## 재현

가상 환경을 활성화하고 `PYTHONPATH`를 `app`으로 설정합니다.

```sh
python -m unittest discover -s tests -p 'test_*.py'
node --test tests/extension.test.mjs
python tests/launcher_integration.py
```

`VISUAL_QA_TEST_CHROME`에 Chrome for Testing 실행 파일 경로를 지정합니다.

```sh
node tests/extension_integration.mjs
node tests/extension_integration.mjs --stale-manifest
```

결과와 화면 이미지는 `verification/`에 생성되며 개인 자료가 포함될 수 있어 Git에서 제외합니다.
긴 시안 검사는 `--original=/path/to/reference.png`로 실행할 수 있습니다.

## 추가 확인이 필요한 사항

Windows에서 실제 브라우저 실행과 사용자 페이지 검수는 아직 직접 확인하지 않았습니다.
Windows용 처음 설정·실행 파일과 공통 소스는 포함했으며 실기 확인이 필요합니다.
PC·MO의 다른 반응형 기준은 사이트에 맞춰 패널의 PC 전환 폭을 조정합니다.
같은 실행의 시안은 자동 연결하며 다른 실행의 시안은 직접 짝을 지정합니다.
