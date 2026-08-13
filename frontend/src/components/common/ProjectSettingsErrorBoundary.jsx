import { Component } from "react";

export default class ProjectSettingsErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="workspace-page"><section className="panel-flat state error error-state" role="alert"><span aria-hidden="true">!</span><div><strong>Project Settings could not render</strong><p>An unexpected display error occurred. No settings were changed.</p><button className="secondary-button" onClick={() => window.location.reload()} type="button">Reload settings</button></div></section></div>;
    return this.props.children;
  }
}
