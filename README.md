# Signature Detector Batch v14.0
BUILD 14.0 · 2026-08-13

## 이번 버전의 목표

성능점검기록부가 PDF 스캔본이든 JPG/PNG 촬영본이든 같은 파이프라인으로 처리합니다.

성공 조건은 다음 실제 작성 블록입니다.

- 숫자가 아직 없는 `년 / 월 / 일`
- `매수인`
- `서명`, `서명 또는 인`, `(인)`
- 필요한 경우 바로 위의 `본인은 / 사실 / 확인` 문맥은 보조 점수로만 사용

일반 본문을 잘라내는 fallback은 삭제했습니다.

## v13.x 실패 원인

1. 스캔 PDF에 hidden OCR text layer가 존재하면 부정확한 텍스트 좌표가 먼저 사용될 수 있었습니다.
2. 날짜 한 글자를 놓쳤을 때 `매수인 + 서명 + 확인문장`만으로 후보를 만들어 본문 오탐이 가능했습니다.
3. 전체/부분 ROI OCR 호출 횟수가 많아 속도가 느렸습니다.
4. progress 단계 값이 timer보다 낮게 다시 기록되면서 %가 뒤로 갈 수 있었습니다.

## v14 구조

### Scan-first

PDF native text layer를 사용하지 않습니다.
PDF 페이지를 이미지로 렌더하고 JPG/PNG와 동일하게 처리합니다.

### 위치 가정 없음

각 페이지/논리 패널을 높이 기준 4개의 overlapping strip으로 나눕니다.

- 0% ~ 34%
- 22% ~ 56%
- 44% ~ 78%
- 66% ~ 100%

따라서 상단/중간/하단 어느 위치든 최소 한 strip의 중앙 영역에 포함됩니다.

가로로 두 문서가 붙은 스캔은 좌/우 논리 패널을 먼저 분리합니다.
첫 pass 실패 시에는 전체 폭 strip으로 다시 검사해 단일 landscape 문서도 놓치지 않습니다.

### Contact-sheet OCR

각 strip을 개별 OCR하지 않습니다.
한 페이지의 strip을 모두 확대해서 하나의 contact sheet로 만든 뒤 Tesseract OCR을 1회 실행합니다.

- portrait: 페이지당 4 strip을 OCR 1회
- 2-page landscape scan: 좌/우 총 8 strip을 OCR 1회

이전처럼 ROI마다 OCR을 여러 번 부르는 구조보다 호출 수가 크게 줄었습니다.

### 엄격한 탐지

일반 본문 fallback 제거.

완전 후보:
- blank `년 -> 월 -> 일`
- nearby `매수인`
- nearby `서명/(인)` 또는 strong confirmation context

OCR이 날짜 한 단위를 놓친 partial 후보는
`매수인 + 서명 + 확인 문맥`이 모두 있어야만 허용합니다.

`인` 한 글자만으로는 서명으로 인정하지 않습니다.

### 숫자 조건

`년`부터 `일` 사이의 같은 행에 숫자 token이 하나라도 있으면
이미 작성된 날짜로 보고 후보에서 제외합니다.

### progress

모든 progress update는:

`max(currentProgress, requestedProgress)`

로 적용하므로 67% -> 54%처럼 뒤로 갈 수 없습니다.
실제 완료 전에는 최대 97%, 완료 시 100%입니다.

### 출력

최종 출력에는 OCR 원문이나 전체 페이지를 표시하지 않습니다.
탐지된 날짜/매수인/서명 작성 블록만 원본에서 다시 crop하고 약 40px margin을 추가해 확대합니다.
