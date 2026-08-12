# Signature Detector Fast v3

핵심 변경:
- 마지막 페이지부터 탐색
- 전체 페이지 OCR 대신 하단 46~48% ROI만 OCR
- 0°를 먼저 시도하고 약할 때만 90/270/180 fallback
- 정밀 word-box OCR은 선택된 1페이지/1각도/하단 ROI에서만 1회
- `연월일/년월일/년·월·일` + `매수인/서명/(인)`을 최종 서명행 anchor로 사용
- 큰 문단 cluster가 아니라 한 줄 높이의 작은 signature target 생성
- 모바일용 signature pad 추가
- 처리 시간 표시

현재 `서명 적용`은 UI 상태까지만 연결되어 있으며 실제 PDF 바이너리 재작성은 다음 단계입니다.
