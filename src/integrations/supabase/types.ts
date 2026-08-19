export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          detail: string | null
          entity_id: string
          entity_type: string
          id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          detail?: string | null
          entity_id: string
          entity_type: string
          id?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          detail?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      approval_requests: {
        Row: {
          acted_at: string | null
          approver_user_id: string | null
          comment: string | null
          deadline_at: string | null
          id: string
          status: string | null
          submission_id: string | null
        }
        Insert: {
          acted_at?: string | null
          approver_user_id?: string | null
          comment?: string | null
          deadline_at?: string | null
          id?: string
          status?: string | null
          submission_id?: string | null
        }
        Update: {
          acted_at?: string | null
          approver_user_id?: string | null
          comment?: string | null
          deadline_at?: string | null
          id?: string
          status?: string | null
          submission_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_requests_approver_user_id_fkey"
            columns: ["approver_user_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "approval_requests_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "form_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_rules: {
        Row: {
          approver_user_id: string | null
          deadline_days: number | null
          form_template_id: string | null
          id: string
          is_auto_added: boolean | null
          label: string | null
        }
        Insert: {
          approver_user_id?: string | null
          deadline_days?: number | null
          form_template_id?: string | null
          id?: string
          is_auto_added?: boolean | null
          label?: string | null
        }
        Update: {
          approver_user_id?: string | null
          deadline_days?: number | null
          form_template_id?: string | null
          id?: string
          is_auto_added?: boolean | null
          label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_rules_approver_user_id_fkey"
            columns: ["approver_user_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "approval_rules_form_template_id_fkey"
            columns: ["form_template_id"]
            isOneToOne: false
            referencedRelation: "form_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      approval_slabs: {
        Row: {
          approver_user_id: string
          form_template_id: string
          id: string
          max_amount: number | null
          min_amount: number
          order_index: number
        }
        Insert: {
          approver_user_id: string
          form_template_id: string
          id?: string
          max_amount?: number | null
          min_amount: number
          order_index?: number
        }
        Update: {
          approver_user_id?: string
          form_template_id?: string
          id?: string
          max_amount?: number | null
          min_amount?: number
          order_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "approval_slabs_approver_user_id_fkey"
            columns: ["approver_user_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "approval_slabs_form_template_id_fkey"
            columns: ["form_template_id"]
            isOneToOne: false
            referencedRelation: "form_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      delegation_rules: {
        Row: {
          created_at: string | null
          delegate_id: string
          delegator_id: string
          end_date: string
          form_template_ids: string[] | null
          id: string
          reason: string | null
          start_date: string
        }
        Insert: {
          created_at?: string | null
          delegate_id: string
          delegator_id: string
          end_date: string
          form_template_ids?: string[] | null
          id?: string
          reason?: string | null
          start_date: string
        }
        Update: {
          created_at?: string | null
          delegate_id?: string
          delegator_id?: string
          end_date?: string
          form_template_ids?: string[] | null
          id?: string
          reason?: string | null
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "delegation_rules_delegate_id_fkey"
            columns: ["delegate_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "delegation_rules_delegator_id_fkey"
            columns: ["delegator_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      employees: {
        Row: {
          department: string | null
          designation: string | null
          employee_id: string
          gate_pass_card_number: string | null
          id: string
          line_manager_id: string | null
          name: string
        }
        Insert: {
          department?: string | null
          designation?: string | null
          employee_id: string
          gate_pass_card_number?: string | null
          id?: string
          line_manager_id?: string | null
          name: string
        }
        Update: {
          department?: string | null
          designation?: string | null
          employee_id?: string
          gate_pass_card_number?: string | null
          id?: string
          line_manager_id?: string | null
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_line_manager_id_fkey"
            columns: ["line_manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      form_fields: {
        Row: {
          field_config: Json | null
          field_name: string | null
          field_type: string | null
          form_template_id: string | null
          id: string
          is_required: boolean | null
          order_index: number | null
        }
        Insert: {
          field_config?: Json | null
          field_name?: string | null
          field_type?: string | null
          form_template_id?: string | null
          id?: string
          is_required?: boolean | null
          order_index?: number | null
        }
        Update: {
          field_config?: Json | null
          field_name?: string | null
          field_type?: string | null
          form_template_id?: string | null
          id?: string
          is_required?: boolean | null
          order_index?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "form_fields_form_template_id_fkey"
            columns: ["form_template_id"]
            isOneToOne: false
            referencedRelation: "form_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      form_submissions: {
        Row: {
          form_template_id: string | null
          id: string
          status: string | null
          submitted_at: string | null
          submitted_by: string | null
        }
        Insert: {
          form_template_id?: string | null
          id?: string
          status?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Update: {
          form_template_id?: string | null
          id?: string
          status?: string | null
          submitted_at?: string | null
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "form_submissions_form_template_id_fkey"
            columns: ["form_template_id"]
            isOneToOne: false
            referencedRelation: "form_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "form_submissions_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      form_templates: {
        Row: {
          category: string | null
          created_at: string | null
          created_by: string | null
          id: string
          name: string
          status: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          name: string
          status?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          name?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "form_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      item_stock: {
        Row: {
          id: string
          item_id: string
          quantity: number
          reserved_quantity: number
          venue_id: string
        }
        Insert: {
          id?: string
          item_id: string
          quantity?: number
          reserved_quantity?: number
          venue_id: string
        }
        Update: {
          id?: string
          item_id?: string
          quantity?: number
          reserved_quantity?: number
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "item_stock_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_stock_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      items: {
        Row: {
          id: string
          name: string
          type: string | null
        }
        Insert: {
          id?: string
          name: string
          type?: string | null
        }
        Update: {
          id?: string
          name?: string
          type?: string | null
        }
        Relationships: []
      }
      maintenance_items: {
        Row: {
          category: string
          id: string
          name: string
        }
        Insert: {
          category: string
          id?: string
          name: string
        }
        Update: {
          category?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      maintenance_request_items: {
        Row: {
          description: string | null
          id: string
          item_id: string | null
          quantity: number
          request_id: string
        }
        Insert: {
          description?: string | null
          id?: string
          item_id?: string | null
          quantity?: number
          request_id: string
        }
        Update: {
          description?: string | null
          id?: string
          item_id?: string | null
          quantity?: number
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_request_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "maintenance_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_request_items_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "maintenance_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_requests: {
        Row: {
          admin_comment: string | null
          assigned_to: string | null
          created_at: string
          id: string
          location: string
          ref_number: string
          requester_id: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          admin_comment?: string | null
          assigned_to?: string | null
          created_at?: string
          id?: string
          location: string
          ref_number: string
          requester_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          admin_comment?: string | null
          assigned_to?: string | null
          created_at?: string
          id?: string
          location?: string
          ref_number?: string
          requester_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      movement_orders: {
        Row: {
          admin_comment: string | null
          assigned_mover_id: string | null
          created_at: string | null
          destination_location: string
          destination_venue_id: string | null
          id: string
          item_id: string | null
          item_name: string
          item_type: string | null
          justification: string | null
          preferred_time: string | null
          quantity: number
          ref_number: string
          requester_id: string
          source_location: string
          source_venue_id: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          admin_comment?: string | null
          assigned_mover_id?: string | null
          created_at?: string | null
          destination_location: string
          destination_venue_id?: string | null
          id?: string
          item_id?: string | null
          item_name: string
          item_type?: string | null
          justification?: string | null
          preferred_time?: string | null
          quantity?: number
          ref_number: string
          requester_id: string
          source_location: string
          source_venue_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          admin_comment?: string | null
          assigned_mover_id?: string | null
          created_at?: string | null
          destination_location?: string
          destination_venue_id?: string | null
          id?: string
          item_id?: string | null
          item_name?: string
          item_type?: string | null
          justification?: string | null
          preferred_time?: string | null
          quantity?: number
          ref_number?: string
          requester_id?: string
          source_location?: string
          source_venue_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "movement_orders_destination_venue_id_fkey"
            columns: ["destination_venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "movement_orders_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "movement_orders_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "movement_orders_source_venue_id_fkey"
            columns: ["source_venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      notice_comments: {
        Row: {
          author_id: string | null
          created_at: string
          id: string
          notice_id: string
          text: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          id?: string
          notice_id: string
          text: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          id?: string
          notice_id?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "notice_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "notice_comments_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
        ]
      }
      notices: {
        Row: {
          category: string | null
          content: string
          created_at: string
          created_by: string | null
          current_approver_id: string | null
          id: string
          status: string
          title: string
          updated_at: string | null
        }
        Insert: {
          category?: string | null
          content: string
          created_at?: string
          created_by?: string | null
          current_approver_id?: string | null
          id?: string
          status?: string
          title: string
          updated_at?: string | null
        }
        Update: {
          category?: string | null
          content?: string
          created_at?: string
          created_by?: string | null
          current_approver_id?: string | null
          id?: string
          status?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "notices_current_approver_id_fkey"
            columns: ["current_approver_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      notification_rules: {
        Row: {
          form_template_id: string | null
          id: string
          is_auto_added: boolean | null
          label: string | null
          notifyee_user_id: string | null
        }
        Insert: {
          form_template_id?: string | null
          id?: string
          is_auto_added?: boolean | null
          label?: string | null
          notifyee_user_id?: string | null
        }
        Update: {
          form_template_id?: string | null
          id?: string
          is_auto_added?: boolean | null
          label?: string | null
          notifyee_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_rules_form_template_id_fkey"
            columns: ["form_template_id"]
            isOneToOne: false
            referencedRelation: "form_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_rules_notifyee_user_id_fkey"
            columns: ["notifyee_user_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      stationery_requests: {
        Row: {
          comments: string | null
          contact_number: string | null
          created_at: string
          current_approver_id: string | null
          department: string | null
          designation: string | null
          division: string | null
          email: string | null
          id: string
          kind: string
          name: string | null
          reason: string | null
          requester_id: string | null
          status: string
          updated_at: string | null
        }
        Insert: {
          comments?: string | null
          contact_number?: string | null
          created_at?: string
          current_approver_id?: string | null
          department?: string | null
          designation?: string | null
          division?: string | null
          email?: string | null
          id?: string
          kind: string
          name?: string | null
          reason?: string | null
          requester_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Update: {
          comments?: string | null
          contact_number?: string | null
          created_at?: string
          current_approver_id?: string | null
          department?: string | null
          designation?: string | null
          division?: string | null
          email?: string | null
          id?: string
          kind?: string
          name?: string | null
          reason?: string | null
          requester_id?: string | null
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stationery_requests_current_approver_id_fkey"
            columns: ["current_approver_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
          {
            foreignKeyName: "stationery_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["employee_id"]
          },
        ]
      }
      submission_values: {
        Row: {
          field_name: string | null
          id: string
          submission_id: string | null
          value: string | null
        }
        Insert: {
          field_name?: string | null
          id?: string
          submission_id?: string | null
          value?: string | null
        }
        Update: {
          field_name?: string | null
          id?: string
          submission_id?: string | null
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "submission_values_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "form_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          floor: string | null
          id: string
          name: string
        }
        Insert: {
          floor?: string | null
          id?: string
          name: string
        }
        Update: {
          floor?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      release_reservation: {
        Args: { p_item_id: string; p_qty: number; p_venue_id: string }
        Returns: undefined
      }
      reserve_stock: {
        Args: { p_item_id: string; p_qty: number; p_venue_id: string }
        Returns: undefined
      }
      transfer_stock: {
        Args: {
          p_dest_venue_id: string
          p_item_id: string
          p_qty: number
          p_source_venue_id: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
