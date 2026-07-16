import { Controller, useForm } from "react-hook-form";

export function TransferForm({ wizard, dispatch }: TransferFormProps) {
  const { control, register } = useForm();
  return (
    <form>
      <input {...register("beneficiaryIban")} />
      <textarea name={'note'} />
      <select value={wizard.currency} onChange={(event) => dispatch({ type: "CURRENCY", value: event.target.value })}>
        <option value="TRY">TRY</option>
      </select>
      <Controller name={`amount`} control={control} render={() => <input />} />
    </form>
  );
}
