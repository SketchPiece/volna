# One-off: registers the design-system sources, fonts and asset catalog in the existing project.
require 'xcodeproj'
root = File.expand_path('..', __dir__)
project = Xcodeproj::Project.open(File.join(root, 'CallAssistant.xcodeproj'))
app = project.targets.find { |t| t.name == 'CallAssistant' }
group = project.main_group.find_subpath('CallAssistant', false)
existing = project.files.map { |f| f.real_path.to_s }
Dir.glob(File.join(root, 'CallAssistant', 'UI', '**', '*.swift')).sort.each do |path|
  next if existing.include?(path)
  ref = group.new_file(path.delete_prefix(File.join(root, 'CallAssistant') + '/'))
  app.add_file_references([ref])
  puts "source: #{ref.path}"
end
resources = group.find_subpath('Resources', false)
Dir.glob(File.join(root, 'CallAssistant', 'Resources', 'Fonts', '*.ttf')).sort.each do |path|
  next if existing.include?(path)
  ref = resources.new_file("Fonts/#{File.basename(path)}")
  app.resources_build_phase.add_file_reference(ref)
  puts "font: #{ref.path}"
end
assets = File.join(root, 'CallAssistant', 'Resources', 'Assets.xcassets')
unless existing.include?(assets)
  ref = resources.new_file('Assets.xcassets')
  app.resources_build_phase.add_file_reference(ref)
  puts "assets: #{ref.path}"
end
project.save
