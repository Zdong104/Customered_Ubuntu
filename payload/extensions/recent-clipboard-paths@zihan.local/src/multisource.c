/*
 * RcpMultiSource: a MetaSelectionSource that offers several mimetypes, each
 * with its own in-memory content.
 *
 * Mutter only ships MetaSelectionSourceMemory, which carries ONE mimetype, and
 * GJS cannot implement MetaSelectionSource in JavaScript because its
 * read_async vfunc takes a GAsyncReadyCallback ("VFunc read_async accepts
 * another callback as a parameter. This is not supported"). So this small
 * subclass is written in C and loaded by the extension as a GIOModule.
 *
 * It does not link against libmutter: the parent GType is looked up by name
 * at load time, and the class struct layout is checked against the size
 * GType reports. A mutter that changed MetaSelectionSourceClass makes the
 * module refuse to register (the extension then stays inert) instead of
 * writing into the wrong vtable slot.
 *
 * Contents are set through the construct-only "contents" property, a GVariant
 * of type a(say): ordered (mimetype, bytes) pairs.
 *
 * Build: make -C src   (writes ../libmultisource.so)
 */
#include <gio/gio.h>

/* Mirror of MetaSelectionSourceClass (mutter meta-selection-source.h,
 * unchanged since 3.36). */
typedef struct
{
  GObjectClass parent_class;

  void           (* activated)     (GObject *source);
  void           (* deactivated)   (GObject *source);
  GList *        (* get_mimetypes) (GObject *source);
  void           (* read_async)    (GObject             *source,
                                    const char          *mimetype,
                                    GCancellable        *cancellable,
                                    GAsyncReadyCallback  callback,
                                    gpointer             user_data);
  GInputStream * (* read_finish)   (GObject       *source,
                                    GAsyncResult  *result,
                                    GError       **error);
} ReplicaSourceClass;

typedef struct
{
  GPtrArray  *mimetypes;  /* char*, offer order; owned by contents */
  GHashTable *contents;   /* char* -> GBytes* */
} RcpPrivate;

enum { PROP_0, PROP_CONTENTS };

#define TYPE_NAME "RcpMultiSource"

static gint private_offset;
static gpointer parent_class;

static inline RcpPrivate *
get_priv (gpointer object)
{
  return G_STRUCT_MEMBER_P (object, private_offset);
}

static void
rcp_set_contents (GObject  *object,
                  GVariant *variant)
{
  RcpPrivate *priv = get_priv (object);
  GVariantIter iter;
  const char *mimetype;
  GVariant *data;

  if (!variant || !g_variant_is_of_type (variant, G_VARIANT_TYPE ("a(say)")))
    return;

  g_variant_iter_init (&iter, variant);
  while (g_variant_iter_next (&iter, "(&s@ay)", &mimetype, &data))
    {
      gsize len = 0;
      gconstpointer bytes = g_variant_get_fixed_array (data, &len, 1);

      if (!g_hash_table_contains (priv->contents, mimetype))
        {
          char *key = g_strdup (mimetype);

          g_ptr_array_add (priv->mimetypes, key);
          g_hash_table_insert (priv->contents, key, g_bytes_new (bytes, len));
        }
      g_variant_unref (data);
    }
}

static void
rcp_set_property (GObject      *object,
                  guint         prop_id,
                  const GValue *value,
                  GParamSpec   *pspec)
{
  switch (prop_id)
    {
    case PROP_CONTENTS:
      rcp_set_contents (object, g_value_get_variant (value));
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
    }
}

static GList *
rcp_get_mimetypes (GObject *source)
{
  RcpPrivate *priv = get_priv (source);
  GList *list = NULL;
  guint i;

  for (i = priv->mimetypes->len; i > 0; i--)
    list = g_list_prepend (list, g_strdup (g_ptr_array_index (priv->mimetypes, i - 1)));
  return list;
}

static void
rcp_read_async (GObject             *source,
                const char          *mimetype,
                GCancellable        *cancellable,
                GAsyncReadyCallback  callback,
                gpointer             user_data)
{
  RcpPrivate *priv = get_priv (source);
  GTask *task = g_task_new (source, cancellable, callback, user_data);
  GBytes *bytes = mimetype ? g_hash_table_lookup (priv->contents, mimetype) : NULL;

  g_task_set_source_tag (task, rcp_read_async);
  if (bytes)
    g_task_return_pointer (task, g_memory_input_stream_new_from_bytes (bytes),
                           g_object_unref);
  else
    g_task_return_new_error (task, G_IO_ERROR, G_IO_ERROR_NOT_FOUND,
                             "Mimetype %s is not offered",
                             mimetype ? mimetype : "(null)");
  g_object_unref (task);
}

static GInputStream *
rcp_read_finish (GObject       *source,
                 GAsyncResult  *result,
                 GError       **error)
{
  g_return_val_if_fail (g_task_is_valid (result, source), NULL);
  return g_task_propagate_pointer (G_TASK (result), error);
}

static void
rcp_finalize (GObject *object)
{
  RcpPrivate *priv = get_priv (object);

  g_clear_pointer (&priv->mimetypes, g_ptr_array_unref);
  g_clear_pointer (&priv->contents, g_hash_table_unref);
  G_OBJECT_CLASS (parent_class)->finalize (object);
}

static void
rcp_instance_init (GTypeInstance *instance,
                   gpointer       g_class)
{
  RcpPrivate *priv = get_priv (instance);

  priv->mimetypes = g_ptr_array_new ();
  priv->contents = g_hash_table_new_full (g_str_hash, g_str_equal, g_free,
                                          (GDestroyNotify) g_bytes_unref);
}

static void
rcp_class_init (gpointer g_class,
                gpointer class_data)
{
  GObjectClass *object_class = G_OBJECT_CLASS (g_class);
  ReplicaSourceClass *source_class = g_class;

  parent_class = g_type_class_peek_parent (g_class);
  g_type_class_adjust_private_offset (g_class, &private_offset);

  object_class->set_property = rcp_set_property;
  object_class->finalize = rcp_finalize;
  source_class->get_mimetypes = rcp_get_mimetypes;
  source_class->read_async = rcp_read_async;
  source_class->read_finish = rcp_read_finish;

  g_object_class_install_property (object_class, PROP_CONTENTS,
    g_param_spec_variant ("contents", NULL, NULL,
                          G_VARIANT_TYPE ("a(say)"), NULL,
                          G_PARAM_WRITABLE | G_PARAM_CONSTRUCT_ONLY |
                          G_PARAM_STATIC_STRINGS));
}

G_MODULE_EXPORT void
g_io_module_load (GIOModule *module)
{
  GTypeInfo info = { 0, };
  GTypeQuery query;
  GType parent, type;

  if (g_type_from_name (TYPE_NAME))
    return;

  parent = g_type_from_name ("MetaSelectionSource");
  if (!parent)
    {
      g_warning ("recent-clipboard-paths: MetaSelectionSource is not registered");
      return;
    }

  g_type_query (parent, &query);
  if (query.class_size != sizeof (ReplicaSourceClass))
    {
      g_warning ("recent-clipboard-paths: MetaSelectionSourceClass is %u bytes, "
                 "expected %zu; not registering", query.class_size,
                 sizeof (ReplicaSourceClass));
      return;
    }

  info.class_size = query.class_size;
  info.class_init = rcp_class_init;
  info.instance_size = query.instance_size;
  info.instance_init = rcp_instance_init;

  type = g_type_register_static (parent, TYPE_NAME, &info, 0);
  private_offset = g_type_add_instance_private (type, sizeof (RcpPrivate));

  /* A statically registered type must never be unloaded: pin the module. */
  g_object_ref (module);
  g_type_module_use (G_TYPE_MODULE (module));
}

G_MODULE_EXPORT void
g_io_module_unload (GIOModule *module)
{
}
