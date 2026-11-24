import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { ArrowRightLeft, RefreshCw, TerminalSquare } from 'lucide-react';
import { buildWsUrl } from '../api/client';
import type { SessionRecord } from '../api/types';

interface TerminalPaneProps {
  session: SessionRecord | null;
  onHandoffSession: (id: string) => void;
  onSwitchToSession: (id: string) => void;
}

export function TerminalPane({
  session,
  onHandoffSession,
  onSwitchToSession
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'closed'>('closed');
  const [reconnectSeq, setReconnectSeq] = useState(0);

  useEffect(() => {
    if (!session || !containerRef.current) return;
    if (session.state === 'EXITED' || session.state === 'HANDED_OFF') {
      setConnState('closed');
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Monaco, monospace",
      theme: {
        background: '#070a10',
        foreground: '#edf2f7',
        cursor: '#4f8ff7'
      },
      scrollback: 5000
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    setConnState('connecting');
    const ws = new WebSocket(
      buildWsUrl(
        `/ws/sessions/${encodeURIComponent(session.id)}/pty?cols=${term.cols}&rows=${term.rows}`
      )
    );

    ws.onopen = () => {
      setConnState('connected');
      fitAddon.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          data?: string;
          message?: string;
          code?: number | null;
        };
        if (msg.type === 'output' && msg.data) {
          term.write(msg.data);
        } else if (msg.type === 'status' && msg.message) {
          term.writeln(`\r\n[Agent Hub] ${msg.message}`);
        } else if (msg.type === 'exit') {
          term.writeln(`\r\n[Agent Hub] 会话已退出 (code=${msg.code ?? 0})`);
        }
      } catch {
        // ignore invalid frame
      }
    };

    ws.onclose = () => {
      setConnState('closed');
    };

    const dataDispose = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {
        // ignore transient layout errors
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataDispose.dispose();
      ws.close();
      term.dispose();
    };
  }, [session?.id, session?.state, reconnectSeq]);

  if (!session) {
    return (
      <section className="center-pane">
        <div className="empty-state">
          <TerminalSquare size={36} color="#4f8ff7" />
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            选择一个会话，或在 Mini 发起新任务
          </div>
          <div style={{ maxWidth: 420 }}>
            Mac 只是轻量级控制壳：所有会话可通过单条双向加密 SSH 隧道实时交互，并在需要时一键无缝移交 Mini 接管。
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="center-pane">
      <div className="terminal-header">
        <div className="terminal-meta">
          <span className="agent-badge">{session.agent}</span>
          <span className="node-tag">{session.nodeId}</span>
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.title}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            ({connState === 'connected' ? 'PTY 已连接' : connState === 'connecting' ? '连接中...' : '未连接'})
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {session.state === 'HANDED_OFF' && session.handedOffToSessionId && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => onSwitchToSession(session.handedOffToSessionId!)}
            >
              跳转到 Mini 接管会话 →
            </button>
          )}
          {session.state !== 'HANDED_OFF' && session.state !== 'EXITED' && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReconnectSeq((n) => n + 1)}
            >
              <RefreshCw size={12} />
              重连终端
            </button>
          )}
          {session.nodeId !== 'mini' &&
            (session.state === 'RUNNING' ||
              session.state === 'WAITING_APPROVAL' ||
              session.state === 'IDLE') && (
              <button
                type="button"
                className="btn btn-sm btn-handoff"
                onClick={() => onHandoffSession(session.id)}
              >
                <ArrowRightLeft size={12} />
                移交 Mini
              </button>
            )}
        </div>
      </div>

      {session.state === 'HANDED_OFF' ? (
        <div className="empty-state">
          <ArrowRightLeft size={32} color="#a855f7" />
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
            该 Mac 会话已移交至 Mini
          </div>
          {session.handedOffToSessionId && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onSwitchToSession(session.handedOffToSessionId!)}
            >
              立即切换到 Mini 接管终端
            </button>
          )}
        </div>
      ) : (
        <div className="terminal-host">
          <div ref={containerRef} className="xterm-wrapper" />
        </div>
      )}
    </section>
  );
}
