import { useReducer } from "react";
import { TransferForm } from "../components/TransferForm";

const INITIAL_STATE = {
  step: 1,
  amount: "",
  confirmed: false
};

export const TransferDetailPage: React.FC = () => {
  const [wizard, dispatch] = useReducer(transferReducer, INITIAL_STATE);
  return <TransferForm wizard={wizard} dispatch={dispatch} />;
};
