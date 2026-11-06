import { Component } from 'react';

/** Last line of defence: a crash in any page shows a calm message instead of a blank screen or a stack trace. */
export default class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('[ui]', err); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="grid min-h-full place-items-center p-6 text-center">
        <div>
          <p className="text-lg font-bold">Something went wrong.</p>
          <p className="mt-1 text-sm text-muted">Please try again.</p>
          <button className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white" onClick={() => window.location.assign('/')}>Reload</button>
        </div>
      </div>
    );
  }
}
