# Author a Kei plugin using SDK v1

Copy template/ and kei_sdk/ to a development workspace outside the Kei repository. Rename the metadata ID to a name in your namespace, change the Japanese labels and implement the actions in main.py. The host provides kei_sdk on the plugin worker's import path at runtime. Bundle your code and HTML files in the ZIP. The installer runs with the standard library and plugin-local source files and does not fetch dependencies.

## Package

- metadata.yaml declares schemaVersion and apiVersion as integer 1. Use a lowercase namespaced ID such as studio.notes, a display name and a quoted semantic version. IDs use lowercase letters, digits, hyphens and underscores, with dots between segments. Each segment starts with a letter.
- permissions lists the scopes the owner can grant. actions lists each id and its declared scope. entries lists id, title, slot, page, actions, and optional order and icon (a short text glyph). Order defaults to 100. Slots are extensions, attachment, selection, character-settings and admin.
- main.py exports initialize(context). Use context.register(action, handler) once per declared action. A handler accepts one dictionary and returns a JSON value. Use context.emit(topic, data) during an action to publish JSON to pages for the current plugin generation. The optional terminate(context) releases resources. Put plugin data under context.data_dir.
- Pages are UTF-8 standalone HTML documents. Inline script can use the scoped message protocol in host-api.md. Declare the actions each page uses. Package paths are case-insensitively unique and use portable ASCII segments. The ZIP contains only regular files, at most 8 MiB compressed, 32 MiB extracted and 256 files.

From the external workspace, with your plugin sources under my-plugin/ and the public kei_sdk/ beside it:

~~~
python -m kei_sdk.pack my-plugin my-plugin.zip
~~~

Install the ZIP in the host, grant the required scopes and enable it. A trusted Electron client can discover both desktop and admin entries through the API.

Python plugin packages execute as the current user. Install trusted native packages. The dedicated process keeps workers and their registration lifecycles separate. Page permissions restrict brokered actions and page sessions. They do not sandbox native Python or grant it OS-level privileges.

Kei follows the AstrBot package naming conventions. Existing AstrBot Python classes require a separate port to implement initialize(context).

Define typed settings in _conf_schema.json and declare config-schema-v1 in requiresFeatures. See [plugin administration](plugin-admin.md) for the supported fields and runtime behavior.
