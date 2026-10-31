// Browser UI files are runtime resources; only Desktop embeds web/.
fn main() { println!("cargo:rerun-if-changed=build.rs"); }
