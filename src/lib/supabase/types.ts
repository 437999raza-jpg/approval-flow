// Hand-written to match supabase/migrations/0001_init.sql.
// Once the project is linked, regenerate with:
//   supabase gen types typescript --linked > src/lib/supabase/types.ts

// ApprovalMax's status set: On review -> On approval -> QBO Ready (final
// admin gate) -> Approved/Synced, with On hold and Cancelled as side
// branches. Collapses what used to be pending_review/pending/in_review/
// held/paid (migrations 0017, 0039).
export type InvoiceStatus =
  | "on_review"
  | "on_approval"
  | "qbo_ready"
  | "approved"
  | "cancelled"
  | "rejected"
  | "on_hold";

export type InvoiceSource = "manual" | "email";

export type OrgRole = "user" | "auditor" | "admin";

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
          inbound_email_local: string | null;
          default_tax_rate: number | null;
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
      projects: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          qbo_id: string | null;
          source: "manual" | "qbo";
          active: boolean;
          created_at: string;
          first_seen_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["projects"]["Row"]
        > & { organization_id: string; name: string };
        Update: Partial<Database["public"]["Tables"]["projects"]["Row"]>;
        Relationships: [];
      };
      approval_workflow_rules: {
        Row: {
          id: string;
          workflow_id: string;
          rule_type:
            | "total_amount"
            | "requester"
            | "supplier"
            | "product_service"
            | "category"
            | "class"
            | "customer";
          operator:
            | "any"
            | "between"
            | "under"
            | "over"
            | "equal"
            | "matches"
            | "not_matches";
          value: string | null;
          value2: string | null;
          rule_order: number;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["approval_workflow_rules"]["Row"]
        > & { workflow_id: string; rule_type: string; operator: string };
        Update: Partial<
          Database["public"]["Tables"]["approval_workflow_rules"]["Row"]
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
          name: string;
          approval_mode: "any" | "all";
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
      approval_workflow_step_approvers: {
        Row: {
          id: string;
          step_id: string;
          approver_user_id: string;
          is_default: boolean;
          row_order: number;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["approval_workflow_step_approvers"]["Row"]
        > & { step_id: string; approver_user_id: string };
        Update: Partial<
          Database["public"]["Tables"]["approval_workflow_step_approvers"]["Row"]
        >;
        Relationships: [];
      };
      approval_workflow_step_conditions: {
        Row: {
          id: string;
          step_approver_id: string;
          field: "class" | "customer" | "supplier" | "category";
          operator: "matches" | "not_matches";
          match_values: string[];
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["approval_workflow_step_conditions"]["Row"]
        > & { step_approver_id: string; field: "class" | "customer" | "supplier" | "category" };
        Update: Partial<
          Database["public"]["Tables"]["approval_workflow_step_conditions"]["Row"]
        >;
        Relationships: [];
      };
      workflow_change_impacts: {
        Row: {
          id: string;
          organization_id: string;
          workflow_id: string;
          step_id: string | null;
          actor_id: string | null;
          summary: string;
          affected: { invoice_id: string; invoice_label: string; before: string[]; after: string[] }[];
          created_at: string;
          dismissed_at: string | null;
        };
        Insert: Partial<
          Database["public"]["Tables"]["workflow_change_impacts"]["Row"]
        > & { organization_id: string; workflow_id: string; summary: string };
        Update: Partial<
          Database["public"]["Tables"]["workflow_change_impacts"]["Row"]
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
          bill_date: string | null;
          due_date: string | null;
          tax_amount: number | null;
          project_id: string | null;
          status: InvoiceStatus;
          source: InvoiceSource;
          source_email: string | null;
          extraction: Record<string, unknown> | null;
          file_path: string;
          file_name: string;
          submitted_by: string | null;
          current_step_order: number;
          accounting_instructions: string | null;
          step_override_approver_id: string | null;
          qbo_bill_id: string | null;
          qbo_sync_status: "pending" | "synced" | "error" | null;
          qbo_synced_at: string | null;
          qbo_error: string | null;
          qbo_vendor_matched: boolean;
          has_cos_or_extras: boolean;
          totals_note: string | null;
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
          mentioned_user_ids: string[];
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
      notifications: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          actor_id: string | null;
          invoice_id: string | null;
          comment_id: string | null;
          type: "mention";
          read: boolean;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["notifications"]["Row"]
        > & { organization_id: string; user_id: string };
        Update: Partial<
          Database["public"]["Tables"]["notifications"]["Row"]
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
      invoice_line_items: {
        Row: {
          id: string;
          invoice_id: string;
          category: string | null;
          description: string | null;
          tax_rate: number | null;
          qbo_tax_code_id: string | null;
          class: string | null;
          project_id: string | null;
          amount: number | null;
          linked: boolean;
          line_order: number;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["invoice_line_items"]["Row"]
        > & { invoice_id: string };
        Update: Partial<
          Database["public"]["Tables"]["invoice_line_items"]["Row"]
        >;
        Relationships: [];
      };
      accounting_instructions: {
        Row: {
          id: string;
          invoice_id: string;
          author_id: string | null;
          body: string;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["accounting_instructions"]["Row"]
        > & { invoice_id: string; body: string };
        Update: Partial<
          Database["public"]["Tables"]["accounting_instructions"]["Row"]
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
      saved_reports: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          config: Record<string, unknown>;
          created_by: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["saved_reports"]["Row"]
        > & { organization_id: string; name: string };
        Update: Partial<
          Database["public"]["Tables"]["saved_reports"]["Row"]
        >;
        Relationships: [];
      };
      qbo_categories: {
        Row: {
          id: string;
          organization_id: string;
          qbo_account_id: string;
          name: string;
          acct_num: string | null;
          account_type: string | null;
          account_sub_type: string | null;
          active: boolean;
          synced_at: string;
          first_seen_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["qbo_categories"]["Row"]
        > & {
          organization_id: string;
          qbo_account_id: string;
          name: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["qbo_categories"]["Row"]
        >;
        Relationships: [];
      };
      qbo_classes: {
        Row: {
          id: string;
          organization_id: string;
          qbo_class_id: string;
          name: string;
          active: boolean;
          sub_class: boolean;
          synced_at: string;
          first_seen_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["qbo_classes"]["Row"]
        > & {
          organization_id: string;
          qbo_class_id: string;
          name: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["qbo_classes"]["Row"]
        >;
        Relationships: [];
      };
      qbo_suppliers: {
        Row: {
          id: string;
          organization_id: string;
          qbo_vendor_id: string;
          name: string;
          name_normalized: string;
          active: boolean;
          synced_at: string;
          integration: string;
          first_seen_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["qbo_suppliers"]["Row"]
        > & {
          organization_id: string;
          qbo_vendor_id: string;
          name: string;
          name_normalized: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["qbo_suppliers"]["Row"]
        >;
        Relationships: [];
      };
      qbo_sync_log: {
        Row: {
          organization_id: string;
          section: "taxes" | "classes" | "categories" | "suppliers" | "projects";
          synced_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["qbo_sync_log"]["Row"]
        > & { organization_id: string; section: string };
        Update: Partial<
          Database["public"]["Tables"]["qbo_sync_log"]["Row"]
        >;
        Relationships: [];
      };
      qbo_tax_codes: {
        Row: {
          id: string;
          organization_id: string;
          qbo_tax_code_id: string;
          name: string;
          description: string | null;
          rate_value: number | null;
          synced_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["qbo_tax_codes"]["Row"]
        > & {
          organization_id: string;
          qbo_tax_code_id: string;
          name: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["qbo_tax_codes"]["Row"]
        >;
        Relationships: [];
      };
      qbo_tax_rates: {
        Row: {
          id: string;
          organization_id: string;
          qbo_tax_rate_id: string;
          name: string;
          rate_value: number;
          synced_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["qbo_tax_rates"]["Row"]
        > & {
          organization_id: string;
          qbo_tax_rate_id: string;
          name: string;
          rate_value: number;
        };
        Update: Partial<
          Database["public"]["Tables"]["qbo_tax_rates"]["Row"]
        >;
        Relationships: [];
      };
      qbo_connections: {
        Row: {
          id: string;
          organization_id: string;
          realm_id: string;
          access_token: string;
          refresh_token: string;
          expires_at: string;
          company_name: string | null;
          connected_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["qbo_connections"]["Row"]
        > & {
          organization_id: string;
          realm_id: string;
          access_token: string;
          refresh_token: string;
          expires_at: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["qbo_connections"]["Row"]
        >;
        Relationships: [];
      };
      supplier_defaults: {
        Row: {
          id: string;
          organization_id: string;
          vendor_name: string;
          vendor_name_normalized: string;
          category: string | null;
          class: string | null;
          project_id: string | null;
          tax_rate: number | null;
          payment_terms_days: number | null;
          currency: string | null;
          product_service: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["supplier_defaults"]["Row"]
        > & { organization_id: string; vendor_name: string };
        Update: Partial<
          Database["public"]["Tables"]["supplier_defaults"]["Row"]
        >;
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
          pending_split_ids: string[];
          processed: boolean;
          processing: boolean;
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
      pending_invoice_splits: {
        Row: {
          id: string;
          organization_id: string;
          source: "manual" | "email";
          source_email: string | null;
          submitted_by: string | null;
          file_path: string;
          file_name: string;
          page_count: number;
          groups: {
            pages: number[];
            vendorHint: string | null;
            invoiceNumberHint: string | null;
          }[];
          status: "pending" | "confirmed" | "dismissed";
          created_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
        };
        Insert: Partial<
          Database["public"]["Tables"]["pending_invoice_splits"]["Row"]
        > & {
          organization_id: string;
          source: "manual" | "email";
          file_path: string;
          file_name: string;
          page_count: number;
          groups: Database["public"]["Tables"]["pending_invoice_splits"]["Row"]["groups"];
        };
        Update: Partial<
          Database["public"]["Tables"]["pending_invoice_splits"]["Row"]
        >;
        Relationships: [];
      };
      ingest_jobs: {
        Row: {
          id: string;
          organization_id: string;
          staging_path: string;
          file_name: string;
          mime_type: string | null;
          file_size_bytes: number | null;
          source: "manual" | "email";
          submitted_by: string | null;
          source_email: string | null;
          status: "queued" | "processing" | "done" | "error";
          attempt_count: number;
          last_error: string | null;
          upload_log_id: string | null;
          inbound_email_log_id: string | null;
          created_at: string;
          updated_at: string;
          processed_at: string | null;
        };
        Insert: Partial<
          Database["public"]["Tables"]["ingest_jobs"]["Row"]
        > & {
          organization_id: string;
          staging_path: string;
          file_name: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["ingest_jobs"]["Row"]
        >;
        Relationships: [];
      };
      upload_log: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string | null;
          filename: string;
          file_type: string | null;
          file_size_bytes: number | null;
          status: "queued" | "processing" | "done" | "split" | "error" | "no_invoice";
          invoice_id: string | null;
          pending_split_id: string | null;
          error: string | null;
          source: "manual" | "email";
          created_at: string;
          processed_at: string | null;
        };
        Insert: Partial<
          Database["public"]["Tables"]["upload_log"]["Row"]
        > & { organization_id: string; filename: string; status: string };
        Update: Partial<
          Database["public"]["Tables"]["upload_log"]["Row"]
        >;
        Relationships: [];
      };
    };
  };
}
