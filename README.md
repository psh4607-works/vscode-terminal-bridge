# VS Code Terminal Bridge

외부 AI가 VS Code 터미널을 생성하고, 목록·실행 상태·출력을 조회하는 로컬 도구입니다.

```text
AI / shell → vscode-terminal CLI → private Unix socket → VS Code extension → Terminal API
```

macOS와 Linux의 데스크톱 VS Code에서 동작합니다. 런타임 npm 의존성은 없으며 CLI에는 Node.js 22 이상이 필요합니다. 첫 버전은 CLI 연결을 제공합니다.

## 설치

```bash
npm ci
npm run package
code --install-extension ./vscode-terminal-bridge-0.2.0.vsix
npm link
```

이미 열린 VS Code 창에서 확장이 활성화되지 않으면 `Developer: Reload Window`를 실행합니다. 신뢰한 작업 공간에서 확장이 시작됩니다. 명령 팔레트의 `Terminal Bridge: Show Connection`에서 해당 창 ID를 확인할 수 있습니다.

## 사용

모든 정상 응답은 JSON 한 줄입니다. 오류는 `{ "error": { "code": "...", "message": "..." } }`와 종료 코드 1로 반환합니다. 창이 하나면 자동 선택하고, 두 개 이상이면 `--window`가 필수입니다.

```bash
# 실행 중인 확장 인스턴스와 작업 공간 조회
vscode-terminal windows

# 창을 선택해 터미널 목록 조회
vscode-terminal --window WINDOW_ID list

# 생성 응답의 id가 TERMINAL_ID입니다.
vscode-terminal --window WINDOW_ID create --name 'AI dev' --cwd /absolute/project --clean-shell

# list에서 shellIntegration:true, state:idle이 된 뒤 실행합니다.
# 실행 응답의 id가 EXECUTION_ID입니다.
vscode-terminal --window WINDOW_ID execute TERMINAL_ID --command 'npm run dev'

vscode-terminal --window WINDOW_ID status EXECUTION_ID
vscode-terminal --window WINDOW_ID read EXECUTION_ID --cursor 0 --limit 16000

# 실행 중인 프로그램에 입력합니다. --enter를 생략하면 Enter를 보내지 않습니다.
vscode-terminal --window WINDOW_ID send TERMINAL_ID --text 'yes' --enter

# 아래 동작은 명시적으로 요청한 대상에만 적용됩니다.
vscode-terminal --window WINDOW_ID interrupt TERMINAL_ID
vscode-terminal --window WINDOW_ID close TERMINAL_ID
```

쉘 명령은 `--command`에 하나의 인수로 전달합니다. 셸에서 호출할 때는 위처럼 따옴표로 감싸거나, 프로그래밍 언어의 subprocess 인수 배열을 사용하세요. CLI는 명령을 자동 재시도하지 않습니다. 응답이 끊겼다면 `list`와 실행 상태를 먼저 확인해야 중복 실행을 피할 수 있습니다.

`--clean-shell`은 `/bin/zsh`를 임시 `ZDOTDIR`로 시작해 사용자 `.zshrc` 등의 초기화 파일을 읽지 않습니다. 현재 Mac에서는 사용자 초기화 설정을 사용하는 셸에서 실행 이벤트가 완료되지 않는 현상이 재현되어, AI용 터미널에는 이 옵션을 권장합니다. VS Code가 물려준 환경 변수는 유지되지만 사용자 셸 파일의 alias·함수·추가 설정은 적용되지 않습니다. 기본 셸 설정을 쓰려면 이 옵션을 생략합니다. 기존 설정 파일은 수정하지 않습니다.

## macOS 스마트 붙여넣기

로컬 VS Code 터미널에 포커스한 상태에서 `Cmd+V`를 누릅니다. 명령 팔레트의 `Terminal Bridge: Smart Paste`로도 실행할 수 있습니다.

| 복사한 내용 | 동작 |
| --- | --- |
| Finder의 이미지 파일 | 원래 경로를 Orca 방식의 bracketed paste로 전달 |
| Finder의 동영상·폴더·일반 파일 | 원래 경로를 셸 인용하여 전달. 여러 항목 지원 |
| 캡처한 이미지 등 비트맵만 있는 클립보드 | 임시 PNG로 저장하고 해당 경로 전달 |
| 일반 텍스트 | VS Code 기본 터미널 붙여넣기 사용 |

파일 URL이 있으면 원본 파일을 우선합니다. 파일 URL 없이 텍스트와 이미지가 함께 있으면 Orca처럼 텍스트를 우선합니다. 이미지 경로에 공백이나 셸 특수문자가 있으면 인용된 일반 경로로 전달합니다. 미디어·파일 경로에 Enter를 추가하지 않습니다. 일반 텍스트는 기본 붙여넣기의 여러 줄 경고 등 기존 동작을 유지합니다.

이미지 첨부나 동영상 해석 자체는 터미널 안에서 실행 중인 AI 도구의 기능에 달려 있습니다. 브리지는 경로와 붙여넣기 입력을 전달하며, 동영상을 변환하거나 폴더를 재귀적으로 읽지 않습니다. VS Code 일반 터미널과 AI 터미널에서 사용할 수 있지만 모든 TUI의 이미지 인식을 보장하지는 않습니다.

설정 `terminalBridge.smartPaste.enabled`를 끄면 기본 `Cmd+V`로 돌아갑니다. 사용자 지정 `Cmd+V` 키 바인딩은 확장 기본값보다 우선합니다. 이 기능은 macOS 전용이며, 원격 SSH/컨테이너 터미널로 로컬 미디어 경로를 보내는 동작은 거부합니다. 텍스트 붙여넣기는 유지합니다.

이미지는 OS 임시 디렉터리 아래 `vscode-terminal-paste-<UUID>/image.png`에 저장합니다. 폴더 권한은 `0700`, 파일은 `0600`입니다. AI가 나중에 읽을 수 있도록 확장 종료 시 삭제하지 않으며 OS 임시 파일 정리 대상입니다. PNG는 최대 18 MiB, 이미지는 약 32M 픽셀입니다. 클립보드가 처리 중 바뀌거나 대상 터미널이 바뀌면 취소합니다.

Orca 참고 구현은 `terminal-clipboard-paste.ts`(텍스트/비트맵), `terminal-drop-path-writer.ts`(이미지와 일반 파일 경로), `terminal-bracketed-paste.ts`입니다. Orca의 Cmd+V 자체에 없던 macOS Finder 파일·폴더 복사를 이 확장에서 함께 처리합니다.

## AI 사용 규칙

1. `windows`로 작업 공간을 확인하고 명시적인 창 ID를 선택합니다.
2. `list`로 터미널의 `id`, `name`, `pid`, `cwd`, `state`, `activeExecutionIds`를 확인합니다.
3. 자동화에는 새 터미널을 만들고 `shellIntegration:true`, `state:idle`을 기다립니다. 초기화 실패 시 무한히 기다리지 말고 제한 시간을 둡니다.
4. `execute`가 반환한 실행 ID로 `status`와 `read`를 조회합니다. `execute`의 성공은 실행 요청 접수이며, 명령 성공을 뜻하지 않습니다.
5. 출력은 응답의 `nextCursor`를 다음 `read --cursor`에 넘겨 증분으로 읽습니다. 실행 종료와 출력 수집 완료는 서로 다른 시점입니다. `status:ended`, `outputComplete:true`, `nextCursor == nextOffset`까지 확인합니다.
6. `exitCode:0`이 성공입니다. `exitCode:null`은 종료 코드를 모른다는 뜻입니다.

실행 중인 터미널에는 기본적으로 `TERMINAL_BUSY`, 기존 터미널의 활동 상태를 판단할 수 없으면 `TERMINAL_STATE_UNKNOWN`을 반환합니다. `execute --allow-interrupt`는 **기존 작업을 Ctrl+C로 중단할 수 있으므로**, 중단 의도가 있을 때만 사용합니다. 상태를 확인하려고 사용하면 안 됩니다.

`send`는 현재 프로그램에 입력을 보내는 기능입니다. 실행 추적 보장을 제공하지 않으며, 유휴 셸에 입력한 후에는 새 실행 이벤트가 관찰될 때까지 상태가 `unknown`이 됩니다. `interrupt`의 응답 역시 키 전달 확인이므로 실제 종료는 `status`로 확인합니다.

## 출력과 지원 범위

- 확장이 관찰하기 시작한 명령부터 출력을 수집합니다. 활성화 전의 터미널 스크롤백은 읽지 못합니다.
- 출력은 ANSI 제어 문자가 포함된 원본 스트림입니다. 터미널 화면 전체를 렌더링한 스냅샷이 아니므로 TUI 화면 복원은 지원하지 않습니다.
- 실행당 최근 65,536 UTF-16 코드 단위를 보관합니다. 커서 단위는 바이트가 아닌 `utf16`이며, 오래된 커서를 요청하면 `truncated:true`와 현재 보존 구간을 반환합니다.
- 실행 이력은 메모리에서만 보관하며 확장 재시작 때 사라집니다. 창·터미널·실행 ID도 재발급됩니다.
- 실행 이력은 최대 64개로 완료된 실행부터 제거합니다. CLI의 동시 실행도 64개로 제한합니다. VS Code에서 사용자가 직접 시작한 실행까지 한도를 넘으면 오래된 실행이 제거될 수 있으며, 해당 ID 조회에는 `EXECUTION_NOT_FOUND`가 반환됩니다.
- Shell Integration이 없는 셸이나 task terminal 등 추적 실행을 지원하지 않는 터미널은 오류를 반환합니다. 자동으로 `sendText` 실행으로 전환하지 않습니다.
- 첫 버전 검증 범위는 로컬 macOS VS Code와 zsh입니다. Linux는 Unix 소켓 통신을 사용하지만 실기 검증하지 않았습니다. Windows, VS Code Web, Remote SSH/컨테이너의 연결 경로는 지원 범위에 포함하지 않습니다.
- `terminal.processId`는 셸 PID입니다. 전체 자식 프로세스 트리나 CPU 사용량을 조회하는 API는 제공하지 않습니다.

## 로컬 연결

기본 연결 디렉터리는 `~/.vscode-terminal-bridge`입니다. 디렉터리는 현재 사용자 소유의 `0700`, socket과 discovery 파일은 `0600`이어야 합니다. HTTP 포트를 열지 않습니다. 같은 OS 사용자 권한으로 실행되는 프로그램은 이 연결을 사용할 수 있습니다.

테스트 등에서 위치를 바꾸려면 VS Code 프로세스에 `VSCODE_TERMINAL_BRIDGE_DIR`를 설정하고 CLI에 같은 `--directory PATH`를 전달합니다. macOS Unix socket 경로 길이 제한 때문에 짧은 경로를 사용해야 합니다. symlink 연결 경로와 안전하지 않은 권한은 거부됩니다. 죽은 확장의 discovery 파일은 조회에서 무시하며, 실행 이력이나 터미널 출력은 디스크에 저장하지 않습니다.

## 개발 및 검증

```bash
npm test
npm run test:integration
npm run package
```

`test:integration`은 설치된 macOS VS Code를 별도 프로필·작업 공간으로 실행합니다. 실제 CLI → socket → 확장 → 터미널 흐름으로 생성, 출력, 종료 코드, busy 보호, 중단, 종료를 검증합니다. 스마트 붙여넣기 명령 등록과 실제 PTY에 전달된 이미지·동영상·폴더 입력도 검사합니다. OS 클립보드 검증은 일반 클립보드와 분리된 named pasteboard를 사용합니다. 결과는 `artifacts/integration.json`에 남습니다. 다른 실행 파일은 `BRIDGE_VSCODE_PATH` 환경 변수로 지정합니다.

VS Code 공개 API만 사용하며 proposed API나 VS Code 앱 파일 수정은 필요하지 않습니다. API 참고: [Terminal](https://code.visualstudio.com/api/references/vscode-api#Terminal), [TerminalShellExecution](https://code.visualstudio.com/api/references/vscode-api#TerminalShellExecution).
