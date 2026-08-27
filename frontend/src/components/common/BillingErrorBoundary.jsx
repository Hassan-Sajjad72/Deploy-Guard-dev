import { Component } from "react";

export default class BillingErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <div className="workspace-page"><section className="panel-flat state error error-state" role="alert"><span aria-hidden="true">!</span><div><strong>Plan &amp; Usage could not render</strong><p>The page encountered an unexpected display error. Your subscription data was not replaced with fallback values.</p><button className="secondary-button" onClick={() => window.location.reload()} type="button">Reload page</button></div></section></div>;
    }
    return this.props.children;
  }
}
