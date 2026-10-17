# Keeps CallAssistant.xcodeproj in sync with the folders on disk without regenerating it.
# - Every *.swift under CallAssistant/ and Shared/ belongs to the app target.
# - Shared/ also belongs to the Siri extension.
# - Tests/UI/*.swift belong to CallAssistantUITests, Tests/Unit/*.swift to CallAssistantTests (created if missing).
# - References to files that no longer exist are removed.
# Run after adding, moving or deleting sources: ruby scripts/sync-project.rb
require 'xcodeproj'
root = File.expand_path('..', __dir__)
project = Xcodeproj::Project.open(File.join(root, 'CallAssistant.xcodeproj'))
app = project.targets.find { |t| t.name == 'CallAssistant' }
extension = project.targets.find { |t| t.name == 'SiriExtension' }
ui_tests = project.targets.find { |t| t.name == 'CallAssistantUITests' }

# Remove references whose files vanished (build files go with them).
project.files.select { |f| f.path.to_s.end_with?('.swift') && !File.exist?(f.real_path) }.each do |ref|
  puts "remove: #{ref.real_path.relative_path_from(Pathname(root))}"
  ref.remove_from_project
end

def ensure_sources(project, target, group, folder, root)
  known = target.source_build_phase.files.map { |bf| bf.file_ref&.real_path.to_s }
  Dir.glob(File.join(root, folder, '**', '*.swift')).sort.each do |path|
    next if known.include?(path)
    ref = project.files.find { |f| f.real_path.to_s == path } || group.new_file(path.delete_prefix(File.join(root, group.path.to_s) + '/'))
    target.add_file_references([ref])
    puts "#{target.name}: #{path.delete_prefix(root + '/')}"
  end
end

unit_tests = project.targets.find { |t| t.name == 'CallAssistantTests' }
unless unit_tests
  unit_tests = project.new_target(:unit_test_bundle, 'CallAssistantTests', :ios, '18.0')
  team = app.build_configurations.first.build_settings['DEVELOPMENT_TEAM']
  unit_tests.build_configurations.each do |config|
    config.build_settings.merge!({
      'SWIFT_VERSION' => '5.0', 'TARGETED_DEVICE_FAMILY' => '1', 'CODE_SIGN_STYLE' => 'Automatic',
      'GENERATE_INFOPLIST_FILE' => 'YES', 'PRODUCT_BUNDLE_IDENTIFIER' => 'dev.prototype.callassistant.tests',
      'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/CallAssistant.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)CallAssistant',
      'BUNDLE_LOADER' => '$(TEST_HOST)', 'SWIFT_STRICT_CONCURRENCY' => 'targeted'
    })
    config.build_settings['DEVELOPMENT_TEAM'] = team if team
  end
  unit_tests.add_dependency(app)
  puts 'target: CallAssistantTests'
  scheme_path = Xcodeproj::XCScheme.shared_data_dir(project.path) + 'CallAssistant.xcscheme'
  scheme = Xcodeproj::XCScheme.new(scheme_path)
  scheme.add_test_target(unit_tests)
  scheme.save!
  puts 'scheme: CallAssistantTests added to CallAssistant'
end

tests_group = project.main_group.find_subpath('Tests', true)
tests_group.path ||= 'Tests'
ensure_sources(project, app, project.main_group.find_subpath('CallAssistant', false), 'CallAssistant', root)
shared_group = project.main_group.find_subpath('Shared', true)
shared_group.path ||= 'Shared'
ensure_sources(project, app, shared_group, 'Shared', root)
ensure_sources(project, extension, shared_group, 'Shared', root)
ensure_sources(project, ui_tests, tests_group, 'Tests/UI', root)
ensure_sources(project, unit_tests, tests_group, 'Tests/Unit', root)
project.save
puts 'saved'
