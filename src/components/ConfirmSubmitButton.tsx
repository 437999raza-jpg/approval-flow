"use client";

// A form-action submit button that requires a native confirm() before
// firing — for destructive server actions (e.g. permanently deleting an
// invoice) where a plain button is too easy to click by accident.
// Authored by Araza.
export function ConfirmSubmitButton({
  action,
  confirmMessage,
  className,
  children,
}: {
  action: () => Promise<void>;
  confirmMessage: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <button type="submit" className={className}>
        {children}
      </button>
    </form>
  );
}
