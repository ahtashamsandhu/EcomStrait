"use client";

import { Check } from "lucide-react";
import { cn } from "@ecomstrait/ui";
import { RequiredMark, TextField } from "@/components/ui";
import type { FieldDef, SupplierForm } from "@/lib/onboarding";
import { STEPS } from "@/lib/onboarding";

export function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {STEPS.map((s) => {
        const done = s.n < current;
        const active = s.n === current;
        return (
          <li key={s.n} className="flex items-center gap-2">
            <span
              className={cn(
                "grid h-7 w-7 place-items-center rounded-full text-xs font-bold transition",
                done && "bg-brand-500 text-white",
                active && "bg-ink-950 text-white",
                !done && !active && "bg-ink-100 text-ink-400",
              )}
            >
              {done ? <Check className="h-4 w-4" /> : s.n}
            </span>
            <span className={cn("text-xs font-medium", active ? "text-ink-950" : "text-ink-400")}>
              {s.title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Select({
  id,
  label,
  value,
  options,
  required,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  required?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink-700">
        {label}
        {required && <RequiredMark />}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-xl border border-ink-200 bg-white px-3 text-sm text-ink-950 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
      >
        <option value="">Select…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function MultiSelect({
  label,
  values,
  options,
  required,
  onChange,
}: {
  label: string;
  values: string[];
  options: string[];
  required?: boolean;
  onChange: (v: string[]) => void;
}) {
  function toggle(o: string) {
    onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o]);
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-ink-700">
        {label}
        {required && <RequiredMark />}
      </span>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = values.includes(o);
          return (
            <button
              key={o}
              type="button"
              onClick={() => toggle(o)}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-medium transition",
                on
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-ink-200 bg-white text-ink-600 hover:border-ink-300",
              )}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function FieldInput({
  def,
  form,
  set,
}: {
  def: FieldDef;
  form: SupplierForm;
  set: <K extends keyof SupplierForm>(k: K, v: SupplierForm[K]) => void;
}) {
  const wrap = def.full ? "sm:col-span-2" : "";

  if (def.type === "multiselect") {
    return (
      <div className={wrap}>
        <MultiSelect
          label={def.label}
          required={def.required}
          values={form[def.name] as string[]}
          options={def.options ?? []}
          onChange={(v) => set(def.name, v as SupplierForm[typeof def.name])}
        />
      </div>
    );
  }
  if (def.type === "select") {
    return (
      <div className={wrap}>
        <Select
          id={def.name}
          label={def.label}
          required={def.required}
          value={form[def.name] as string}
          options={def.options ?? []}
          onChange={(v) => set(def.name, v as SupplierForm[typeof def.name])}
        />
      </div>
    );
  }
  if (def.type === "textarea") {
    return (
      <div className={cn("flex flex-col gap-1.5", wrap)}>
        <label htmlFor={def.name} className="text-sm font-medium text-ink-700">
          {def.label}
          {def.required && <RequiredMark />}
        </label>
        <textarea
          id={def.name}
          rows={4}
          placeholder={def.placeholder}
          value={form[def.name] as string}
          onChange={(e) => set(def.name, e.target.value as SupplierForm[typeof def.name])}
          className="rounded-xl border border-ink-200 bg-white p-3 text-sm text-ink-950 outline-none transition placeholder:text-ink-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
        />
      </div>
    );
  }
  return (
    <div className={wrap}>
      <TextField
        id={def.name}
        label={def.label}
        required={def.required}
        placeholder={def.placeholder}
        value={form[def.name] as string}
        onChange={(e) => set(def.name, e.target.value as SupplierForm[typeof def.name])}
      />
    </div>
  );
}
