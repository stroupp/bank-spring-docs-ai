import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { customerApi } from "../api-clients/customerApi";

export function CustomerSearchPage() {
  const [status, setStatus] = useState<string>("ACTIVE");
  const { control, register, handleSubmit } = useForm();

  async function submitSearch(values: Record<string, string>) {
    await customerApi.searchCustomers({ ...values, status });
  }

  return (
    <form onSubmit={handleSubmit(submitSearch)}>
      <input name="customerName" {...register("customerName")} />
      <Controller name="status" control={control} render={() => <select onChange={(event) => setStatus(event.target.value)} />} />
      <button onClick={() => setStatus("ACTIVE")}>Aktifleri Göster</button>
      <button type="submit">Ara</button>
    </form>
  );
}
