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
          marketing_opt_in: boolean;
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
          default_tax_code_id: string | null;
          usage_rate_usd: number;
          usage_rate_updated_at: string | null;
          stripe_customer_id: string | null;
          plan: "starter" | "growth" | "scale" | "detailed" | null;
          plan_selected_at: string | null;
          statement_reply_to: string | null;
          trial_ends_at: string | null;
          // Negotiated per-org plan overriding `plan`, and the one-time
          // build fee (migration 0095). custom_plan's shape is validated
          // by parseCustomPlan() in src/lib/plans.ts — JSONB here, so
          // `unknown` is the honest type.
          custom_plan: unknown;
          // House account (migration 0096): full access, never billed.
          is_internal: boolean;
          // Retainage / holdback config (migration 0097). retainage_term
          // is the word this org's people see; the columns are named
          // neutrally because the concept has three names by market.
          retainage_term: "holdback" | "retainage" | "retention";
          retainage_default_rate: number | null;
          retainage_account_qbo_id: string | null;
          setup_fee_usd: number | null;
          setup_fee_label: string | null;
          setup_fee_paid_at: string | null;
          // Days after a step's own deadline before escalating (migration
          // 0094). Replaces the hardcoded ESCALATION_GRACE_DAYS constant.
          escalation_grace_days: number;
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
          // Stand-in cover while this member is away (migration 0094).
          // substitute_until is inclusive; null means "until cleared".
          substitute_user_id: string | null;
          substitute_until: string | null;
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
          // Retainage per job (migration 0097): a rate overriding the org
          // default, and the two dates that decide when it's releasable.
          retainage_rate: number | null;
          substantial_performance_at: string | null;
          retainage_released_at: string | null;
          created_at: string;
          first_seen_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["projects"]["Row"]
        > & { organization_id: string; name: string };
        Update: Partial<Database["public"]["Tables"]["projects"]["Row"]>;
        Relationships: [];
      };
      invoice_retainage: {
        Row: {
          id: string;
          organization_id: string;
          invoice_id: string;
          // The holdback line this came from (migration 0099). One
          // accrual per line: a bill can carry several, and lines carry
          // their own project_id, so two holdbacks on one invoice can
          // belong to two different jobs.
          line_item_id: string | null;
          project_id: string | null;
          supplier_id: string | null;
          amount: number;
          rate: number | null;
          // Did the sub show the deduction on their invoice, or did we
          // withhold it ourselves? Different conversations six months on.
          source: "billed" | "withheld";
          status: "accrued" | "claim_requested" | "released" | "written_off";
          claim_requested_at: string | null;
          released_at: string | null;
          release_invoice_id: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["invoice_retainage"]["Row"]
        > & { organization_id: string; invoice_id: string; amount: number };
        Update: Partial<Database["public"]["Tables"]["invoice_retainage"]["Row"]>;
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
          deadline_days: number | null;
          created_at: string;
          // Who gets paged when this step blows its deadline (migration
          // 0094). Null = every org admin, the pre-0094 behavior.
          escalate_to_user_id: string | null;
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
          document_total: number | null;
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
          current_step_entered_at: string;
          escalated_at: string | null;
          accounting_instructions: string | null;
          step_override_approver_id: string | null;
          qbo_bill_id: string | null;
          qbo_sync_status: "pending" | "synced" | "error" | null;
          qbo_synced_at: string | null;
          qbo_error: string | null;
          qbo_payment_status: "paid" | "unpaid" | null;
          qbo_paid_at: string | null;
          qbo_vendor_matched: boolean;
          totals_note: string | null;
          supplier_id: string | null;
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
      support_messages: {
        Row: {
          id: string;
          organization_id: string;
          author_id: string | null;
          body: string;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["support_messages"]["Row"]
        > & { organization_id: string; body: string };
        Update: Partial<
          Database["public"]["Tables"]["support_messages"]["Row"]
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
          type: "mention" | "assigned" | "rejected";
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
          // From QBO's Vendor.PrimaryEmailAddr — needed to ask a
          // subcontractor to invoice for their retainage (migration 0097).
          email: string | null;
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
          section: "taxes" | "classes" | "categories" | "suppliers" | "projects" | "payment_status";
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
          supplier_id: string | null;
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
          email_id: string | null;
          from_address: string | null;
          to_address: string | null;
          subject: string | null;
          attachment_count: number;
          invoice_ids: string[];
          pending_split_ids: string[];
          skipped_attachments: { name: string; reason: string }[] | null;
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
          force_split: boolean;
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
      usage_events: {
        Row: {
          id: string;
          organization_id: string;
          document_name: string;
          source: "email" | "manual";
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["usage_events"]["Row"]
        > & { organization_id: string; document_name: string };
        Update: Partial<
          Database["public"]["Tables"]["usage_events"]["Row"]
        >;
        Relationships: [];
      };
      llm_usage_events: {
        Row: {
          id: string;
          organization_id: string;
          purpose: "extract" | "classify" | "search" | "statement";
          model: string;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          total_tokens: number | null;
          cost_usd: number | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["llm_usage_events"]["Row"]
        > & { organization_id: string; purpose: string; model: string };
        Update: Partial<
          Database["public"]["Tables"]["llm_usage_events"]["Row"]
        >;
        Relationships: [];
      };
      feature_flags: {
        Row: {
          key: string;
          description: string | null;
          global_enabled: boolean;
          updated_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["feature_flags"]["Row"]
        > & { key: string };
        Update: Partial<
          Database["public"]["Tables"]["feature_flags"]["Row"]
        >;
        Relationships: [];
      };
      feature_flag_overrides: {
        Row: {
          id: string;
          flag_key: string;
          organization_id: string;
          enabled: boolean;
          updated_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["feature_flag_overrides"]["Row"]
        > & { flag_key: string; organization_id: string; enabled: boolean };
        Update: Partial<
          Database["public"]["Tables"]["feature_flag_overrides"]["Row"]
        >;
        Relationships: [];
      };
      platform_config: {
        Row: {
          id: boolean;
          config_version: number;
          updated_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["platform_config"]["Row"]
        >;
        Update: Partial<
          Database["public"]["Tables"]["platform_config"]["Row"]
        >;
        Relationships: [];
      };
      support_thread_state: {
        Row: {
          organization_id: string;
          last_read_at: string | null;
        };
        Insert: Partial<
          Database["public"]["Tables"]["support_thread_state"]["Row"]
        > & { organization_id: string };
        Update: Partial<
          Database["public"]["Tables"]["support_thread_state"]["Row"]
        >;
        Relationships: [];
      };
      vendor_statements: {
        Row: {
          id: string;
          organization_id: string;
          supplier_name: string;
          file_path: string;
          file_name: string;
          uploaded_by: string | null;
          status: "processing" | "reconciled" | "error";
          error_message: string | null;
          statement_date: string | null;
          statement_balance: number | null;
          note: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["vendor_statements"]["Row"]
        > & { organization_id: string; supplier_name: string; file_path: string; file_name: string };
        Update: Partial<
          Database["public"]["Tables"]["vendor_statements"]["Row"]
        >;
        Relationships: [];
      };
      vendor_statement_lines: {
        Row: {
          id: string;
          statement_id: string;
          invoice_number: string;
          statement_date: string | null;
          amount: number | null;
          match_status: "matched" | "missing_in_flow";
          matched_invoice_id: string | null;
          created_at: string;
        };
        Insert: Partial<
          Database["public"]["Tables"]["vendor_statement_lines"]["Row"]
        > & { statement_id: string; invoice_number: string; match_status: "matched" | "missing_in_flow" };
        Update: Partial<
          Database["public"]["Tables"]["vendor_statement_lines"]["Row"]
        >;
        Relationships: [];
      };
      mfa_recovery_codes: {
        Row: {
          id: string;
          user_id: string;
          code_hash: string;
          used_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["mfa_recovery_codes"]["Row"]> & {
          user_id: string;
          code_hash: string;
        };
        Update: Partial<Database["public"]["Tables"]["mfa_recovery_codes"]["Row"]>;
        Relationships: [];
      };
      suppliers: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          name_normalized: string;
          qbo_vendor_id: string | null;
          // Works under a contract, so holdback applies (migration 0098).
          // Materials and rental suppliers are false — and false is the
          // default, since withholding from a supplier who was never owed
          // a holdback is the failure that matters.
          is_subcontractor: boolean;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["suppliers"]["Row"]> & {
          organization_id: string;
          name: string;
        };
        Update: Partial<Database["public"]["Tables"]["suppliers"]["Row"]>;
        Relationships: [];
      };
    };
  };
}
