import React from "react";
import { transferApi } from "../api-clients/transferApi";

export function ApprovalPanel() {
  async function approveRelease() {
    await transferApi.approve("release-1", "checker-1");
  }
  return <button onClick={approveRelease}>Approve</button>;
}
