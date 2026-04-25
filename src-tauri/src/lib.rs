use keyring::Entry;

// Builder-local keychain commands. See ADR-0003.
//
// `service` is the namespaced service identifier (e.g. "com.airtec.builder.vercel").
// `account` is the per-credential discriminator (e.g. "default").
// Errors are returned to the webview as plain strings; the TypeScript wrapper
// at `lib/keychain/index.ts` re-wraps them into a discriminated `KeychainError`.

#[tauri::command]
fn keychain_get(service: String, account: String) -> Result<Option<String>, String> {
  let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(secret) => Ok(Some(secret)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

#[tauri::command]
fn keychain_set(service: String, account: String, secret: String) -> Result<(), String> {
  let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
  entry.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_delete(service: String, account: String) -> Result<(), String> {
  let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
  match entry.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      keychain_get,
      keychain_set,
      keychain_delete
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
