require 'xcodeproj'
require 'fileutils'
root = File.expand_path('..', __dir__)
project = Xcodeproj::Project.new(File.join(root, 'CallAssistant.xcodeproj'))
app = project.new_target(:application, 'CallAssistant', :ios, '18.0')
extension = project.new_target(:app_extension, 'SiriExtension', :ios, '18.0')
tests = project.new_target(:ui_test_bundle, 'CallAssistantUITests', :ios, '18.0')
unit = project.new_target(:unit_test_bundle, 'CallAssistantTests', :ios, '18.0')
shared = project.main_group.new_group('Shared', 'Shared')
shared_refs = Dir.glob(File.join(root, 'Shared', '*.swift')).sort.map { |path| shared.new_file(File.basename(path)) }
[[app, 'CallAssistant', nil], [extension, 'SiriExtension', nil], [tests, 'Tests', 'UI'], [unit, 'Tests', 'Unit']].each do |target, folder, sub|
  group = project.main_group.find_subpath(folder, false) || project.main_group.new_group(folder, folder)
  Dir.glob(File.join(root, folder, *[sub].compact, '**', '*.swift')).sort.each do |path|
    target.add_file_references([group.new_file(path.delete_prefix(File.join(root, folder) + '/'))])
  end
  target.add_file_references(shared_refs) if [app, extension].include?(target)
  target.build_configurations.each do |config|
    config.build_settings.merge!({ 'SWIFT_VERSION' => '5.0', 'TARGETED_DEVICE_FAMILY' => '1',
      'CODE_SIGN_STYLE' => 'Automatic', 'CURRENT_PROJECT_VERSION' => '1', 'MARKETING_VERSION' => '0.1.0',
      'GENERATE_INFOPLIST_FILE' => 'NO', 'SWIFT_STRICT_CONCURRENCY' => 'targeted',
      'INFOPLIST_FILE' => "#{folder}/Info.plist", 'PRODUCT_BUNDLE_IDENTIFIER' => "dev.prototype.callassistant#{target == extension ? '.siri' : target == tests ? '.uitests' : target == unit ? '.tests' : ''}" })
  end
end
app.build_configurations.each { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'CallAssistant/CallAssistant.entitlements' }
resources = project.main_group.find_subpath('CallAssistant', false).new_group('Resources', 'Resources')
%w[AppShortcuts.strings Localizable.strings InfoPlist.strings].each do |name|
  variant = resources.new_variant_group(name)
  %w[en ru].each do |language|
    ref = variant.new_file("#{language}.lproj/#{name}")
    ref.name = language
  end
  app.resources_build_phase.add_file_reference(variant)
end
project.root_object.known_regions |= ['en', 'ru']
Dir.glob(File.join(root, 'CallAssistant', 'Resources', 'Fonts', '*.ttf')).sort.each do |path|
  app.resources_build_phase.add_file_reference(resources.new_file("Fonts/#{File.basename(path)}"))
end
app.resources_build_phase.add_file_reference(resources.new_file('Assets.xcassets'))
app.build_configurations.each do |c|
  c.build_settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
  c.build_settings['ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'] = 'AccentColor'
end
extension.build_configurations.each { |c| c.build_settings['APPLICATION_EXTENSION_API_ONLY'] = 'YES'; c.build_settings['SKIP_INSTALL'] = 'YES' }
tests.build_configurations.each { |c| c.build_settings['TEST_TARGET_NAME'] = 'CallAssistant'; c.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'; c.build_settings.delete('INFOPLIST_FILE') }
unit.build_configurations.each do |c|
  c.build_settings['GENERATE_INFOPLIST_FILE'] = 'YES'; c.build_settings.delete('INFOPLIST_FILE')
  c.build_settings['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/CallAssistant.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)CallAssistant'
  c.build_settings['BUNDLE_LOADER'] = '$(TEST_HOST)'
end
unit.add_dependency(app)
app.add_dependency(extension)
tests.add_dependency(app)
embed = app.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13'
embed.add_file_reference(extension.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
package = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
package.repositoryURL = 'https://github.com/stasel/WebRTC.git'
package.requirement = { 'kind' => 'exactVersion', 'version' => '153.0.0' }
project.root_object.package_references << package
product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = 'WebRTC'
app.package_product_dependencies << product
build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
build_file.product_ref = product
app.frameworks_build_phase.files << build_file
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.set_launch_target(app)
scheme.add_test_target(tests)
scheme.add_test_target(unit)
scheme.save_as(project.path, 'CallAssistant', true)
