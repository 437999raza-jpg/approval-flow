// Hand-written to match supabase/migrations/0001_init.sql.
// Once the project is linked, regenerate with:
//   supabase gen types typescript --linked > src/lib/supabase/types.ts

export type InvoiceStatus =
  | "pending"
  | "in_review"
  | "approved"
  | "rejected"
  | "paid";

export type InvoiceSource = "manual" | "email";

export type OrgRole = "admin" | "approver" | "submitter";

export interface Database {
  public: {
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["profiles"]["Row"]> & {
          id: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Row"]>;
        Relationships: [];
      };
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          inbound_email_token: string;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["organizations"]["Row"]
        > & { name: string; slug: string };
        Update: Partial<Database["public"]["Tables"]["organizations"]["Row"]>;
        Relationships: [];
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          role: OrgRole;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["organization_members"]["Row"]
        > & { organization_id: string; user_id: string; role: OrgRole };
        Update: Partial<
          Database["public"]["Tables"]["organization_members"]["Row"]
        >;
        Relationships: [];
      };
      approval_workflows: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          is_default: boolean;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["approval_workflows"]["Row"]
        > & { organization_id: string; name: string };
        Update: Partial<
          Database["public"]["Tables"]["approval_workflows"]["Row"]
        >;
        Relationships: [];
      };
      approval_workflow_steps: {
        Row: {
          id: string;
          workflow_id: string;
          step_order: number;
          approver_user_id: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["approval_workflow_steps"]["Row"]
        > & { workflow_id: string; step_order: number };
        Update: Partial<
          Database["public"]["Tables"]["approval_workflow_steps"]["Row"]
        >;
        Relationships: [];
      };
      invoices: {
        Row: {
          id: string;
          organization_id: string;
          workflow_id: string | null;
          vendor_name: string | null;
          invoice_number: string | null;
          amount: number | null;
          currency: string;
          due_date: string | null;
          status: InvoiceStatus;
          source: InvoiceSource;
          source_email: string | null;
          file_path: string;
          file_name: string;
          submitted_by: string | null;
          current_step_order: number;
          accounting_instructions: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["invoices"]["Row"]> & {
          organization_id: string;
          source: InvoiceSource;
          file_path: string;
          file_name: string;
        };
        Update: Partial<Database["public"]["Tables"]["invoices"]["Row"]>;
        Relationships: [];
      };
      invoice_approvals: {
        Row: {
          id: string;
          invoice_id: string;
          step_order: number;
          approver_id: string | null;
          decision: "approved" | "rejected";
          comment: string | null;
          decided_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["invoice_approvals"]["Row"]
        > & {
          invoice_id: string;
          step_order: number;
          decision: "approved" | "rejected";
        };
        Update: Partial<
          Database["public"]["Tables"]["invoice_approvals"]["Row"]
        >;
        Relationships: [];
      };
      invoice_comments: {
        Row: {
          id: string;
          invoice_id: string;
          author_id: string | null;
          body: string;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["invoice_comments"]["Row"]
        > & { invoice_id: string; body: string };
        Update: Partial<
          Database["public"]["Tables"]["invoice_comments"]["Row"]
        >;
        Relationships: [];
      };
      invoice_documents: {
        Row: {
          id: string;
          invoice_id: string;
          file_path: string;
          file_name: string;
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["invoice_documents"]["Row"]
        > & { invoice_id: string; file_path: string; file_name: string };
        Update: Partial<
          Database["public"]["Tables"]["invoice_documents"]["Row"]
        >;
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          organization_id: string;
          invoice_id: string | null;
          actor_id: string | null;
          action: string;
          metadata: Record<string, unknown> | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["audit_log"]["Row"]> & {
          organization_id: string;
          action: string;
        };
        Update: Partial<Database["public"]["Tables"]["audit_log"]["Row"]>;
        Relationships: [];
      };
      inbound_email_log: {
        Row: {
          id: string;
          organization_id: string | null;
          from_address: string | null;
          to_address: string | null;
          subject: string | null;
          attachment_count: number;
          invoice_ids: string[];
          processed: boolean;
          error: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["inbound_email_log"]["Row"]
        >;
        Update: Partial<
          Database["public"]["Tables"]["inbound_email_log"]["Row"]
        >;
        Relationships: [];
      };
    };
  };
}
