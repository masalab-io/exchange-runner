$stdout.sync = true
$stderr.sync = true

# Protocol markers (parsed by the VS Code extension; not shown raw to the user):
#   <<SCRIPT_START>>name   script about to be evaluated
#   <<SCRIPT_DONE>>        script loaded OK
#   <<SCRIPT_ERROR>>msg    script raised an exception on load
#   <<RESULT>>val<<TYPE>>type   eval produced a value
#   <<ERROR>>cls: msg      eval raised an exception
#   <<READY>>              REPL is waiting for the next input line
#   <<VARS>>json           local-variable snapshot (single-line JSON)
#   <<EXIT>>               REPL loop is exiting
#   (all other lines)      plain stdout from the user's script

# Absolute path to this repl.rb — used to filter internal frames from backtraces
REPL_SCRIPT_PATH = File.expand_path(__FILE__).freeze

# ── Path resolution (priority: ruby_path.txt > PID file > ARGV[0]) ───────────

def read_ruby_path_from_dir
  path_file = File.join(File.dirname(File.expand_path(__FILE__)), 'ruby_path.txt')
  return nil unless File.exist?(path_file)
  File.read(path_file).strip
end

def read_ruby_path_from_pid_file
  pid = ENV['ICM_REPL_PID'].to_s.strip
  return nil if pid.empty?
  tmp = ENV['TEMP'] || ENV['TMP'] || '/tmp'
  path_file = File.join(tmp, "icm_ruby_#{pid}.txt")
  return nil unless File.exist?(path_file)
  path = File.read(path_file).strip
  File.delete(path_file) rescue nil
  path
end

argv_path = ARGV[0].to_s.strip
argv_path = '' unless argv_path.end_with?('.rb')
ruby_file_path = (read_ruby_path_from_dir || read_ruby_path_from_pid_file || argv_path).to_s.strip

if ruby_file_path.empty?
  puts '<<ERROR>>Usage: repl.rb <path-to-ruby-file>'
  exit 1
end
unless ruby_file_path.end_with?('.rb') && File.exist?(ruby_file_path)
  puts "<<ERROR>>File not found: #{ruby_file_path}"
  exit 1
end

# ── Variable helpers ──────────────────────────────────────────────────────────

MAX_VALUE_LENGTH         = 200
MAX_VAR_DEPTH            = 3
MAX_COLLECTION_ELEMENTS  = 100

# Safe attribute names to probe on non-standard / ICM objects.
# Only called after respond_to? confirms they exist — never called blindly.
SAFE_PROBE_METHODS = %w[Name name ID Id id Type type modified_by comment path].freeze

def value_str(obj)
  # Summarise large collections instead of dumping a huge inspect string
  if obj.is_a?(Array) && obj.length > 10
    return "Array (#{obj.length} elements)"
  elsif obj.is_a?(Hash) && obj.length > 10
    return "Hash (#{obj.length} entries)"
  end

  s = begin
        obj.inspect.to_s
      rescue NoMemoryError, SystemStackError => e
        raise e
      rescue Exception
        begin; obj.to_s; rescue Exception; '?'; end
      end
  if s.start_with?('#<')
    # WSStructure: show row count summary
    if (obj.class.to_s rescue '') == 'WSStructure' && (obj.respond_to?(:length) rescue false)
      len = begin; obj.length; rescue Exception; nil; end
      return "WSStructure (#{len} rows)" if len
    end
    # For opaque objects try human-readable attributes in priority order:
    # 1. Name/name  2. ID/Id/id  3. path  4. to_s
    %i[Name name ID Id id path].each do |m|
      next unless (obj.respond_to?(m) rescue false)
      v = begin; obj.public_send(m).to_s; rescue Exception; next; end
      next if v.empty? || v.start_with?('#<')
      return v.length > MAX_VALUE_LENGTH ? v[0, MAX_VALUE_LENGTH] + '...' : v
    end
    ts = begin; obj.to_s; rescue Exception; nil; end
    s = ts if ts && !ts.start_with?('#<')
  end
  s.length > MAX_VALUE_LENGTH ? s[0, MAX_VALUE_LENGTH] + '...' : s
rescue NoMemoryError, SystemStackError => e
  raise e
rescue Exception
  '?'
end

def build_var_node(obj, depth, visited)
  node = { 'value' => value_str(obj), 'type' => (obj.class.to_s rescue '?') }
  children = {}
  if depth > 0
    # ── Array elements ──
    if obj.is_a?(Array)
      obj.each_with_index do |elem, i|
        break if i >= MAX_COLLECTION_ELEMENTS
        begin
          elem_id = elem.object_id rescue nil
          next if elem_id && visited.include?(elem_id)
          children["[#{i}]"] = build_var_node(elem, depth - 1, visited + [elem_id].compact)
        rescue NoMemoryError, SystemStackError => e
          raise e
        rescue Exception
          children["[#{i}]"] = { 'value' => '<error reading>', 'type' => '?', 'children' => {} }
        end
      end
      if obj.length > MAX_COLLECTION_ELEMENTS
        children["..."] = { 'value' => "#{obj.length - MAX_COLLECTION_ELEMENTS} more elements", 'type' => 'truncated', 'children' => {} }
      end
    end

    # ── Hash entries ──
    if obj.is_a?(Hash)
      obj.each_with_index do |(k, v), i|
        break if i >= MAX_COLLECTION_ELEMENTS
        begin
          key_label = begin; k.inspect.to_s; rescue Exception; k.to_s; end
          key_label = key_label[0, 50] + '...' if key_label.length > 50
          v_id = v.object_id rescue nil
          next if v_id && visited.include?(v_id)
          children[key_label] = build_var_node(v, depth - 1, visited + [v_id].compact)
        rescue NoMemoryError, SystemStackError => e
          raise e
        rescue Exception
          children[key_label] = { 'value' => '<error reading>', 'type' => '?', 'children' => {} }
        end
      end
      if obj.length > MAX_COLLECTION_ELEMENTS
        children["..."] = { 'value' => "#{obj.length - MAX_COLLECTION_ELEMENTS} more entries", 'type' => 'truncated', 'children' => {} }
      end
    end

    # ── WSStructure (indexed ICM blob collection) ──
    # WSStructure has no Ruby ivars; iterate rows via length + [] index access.
    if (obj.class.to_s rescue '') == 'WSStructure'
      len = begin; obj.length; rescue Exception; 0; end
      count = [len, MAX_COLLECTION_ELEMENTS].min
      count.times do |i|
        begin
          row = obj[i]
          row_id = row.object_id rescue nil
          next if row_id && visited.include?(row_id)
          children["[#{i}]"] = build_var_node(row, depth - 1, visited + [row_id].compact)
        rescue NoMemoryError, SystemStackError => e
          raise e
        rescue Exception
          children["[#{i}]"] = { 'value' => '<error reading>', 'type' => '?', 'children' => {} }
        end
      end
      if len > MAX_COLLECTION_ELEMENTS
        children['...'] = { 'value' => "#{len - MAX_COLLECTION_ELEMENTS} more rows", 'type' => 'truncated', 'children' => {} }
      end
    end

    ivars = begin; obj.instance_variables; rescue Exception; []; end
    ivars.each do |ivar|
      begin
        child    = obj.instance_variable_get(ivar)
        child_id = child.object_id rescue nil
        next if child_id && visited.include?(child_id)
        children[ivar.to_s] = build_var_node(child, depth - 1, visited + [child_id].compact)
      rescue NoMemoryError, SystemStackError => e
        raise e
      rescue Exception
        children[ivar.to_s] = { 'value' => '<error reading>', 'type' => '?', 'children' => {} }
      end
    end
    # For C-extension / opaque objects with no instance_variables (e.g. ICM types, Date),
    # probe only a small whitelist of known-safe read-only attribute names.
    if ivars.empty?
      SAFE_PROBE_METHODS.each do |m|
        begin
          next unless (obj.respond_to?(m) rescue false)
          child = obj.public_send(m)
          child_id = child.object_id rescue nil
          next if child_id && visited.include?(child_id)
          children[".#{m}"] = build_var_node(child, depth - 1, visited + [child_id].compact)
        rescue NoMemoryError, SystemStackError => e
          raise e
        rescue Exception
          children[".#{m}"] = { 'value' => '<error reading>', 'type' => '?', 'children' => {} }
        end
      end
      # Enumerate table_info fields for ICM row objects (WSRowObject, WSStructureRow, etc.)
      # Bypass respond_to? — ICM C-extension objects often don't implement it correctly.
      begin
        ti = obj.table_info
        ti_fields = ti.fields rescue nil
        if ti_fields.is_a?(Array)
          ti_fields.each do |f|
            begin
              fname = f.name.to_s
              next if fname.empty?
              fval = obj[fname]
              fval_id = fval.object_id rescue nil
              next if fval_id && visited.include?(fval_id)
              children[fname] = build_var_node(fval, depth - 1, visited + [fval_id].compact)
            rescue NoMemoryError, SystemStackError => e
              raise e
            rescue Exception
              children[fname] = { 'value' => '<error reading>', 'type' => '?', 'children' => {} }
            end
          end
        end
      rescue NoMemoryError, SystemStackError => e
        raise e
      rescue Exception
        # table_info introspection failed silently
      end
    end
  end
  node['children'] = children
  node
rescue NoMemoryError, SystemStackError => e
  raise e
rescue Exception
  { 'value' => '<error>', 'type' => '?', 'children' => {} }
end

def emit_vars(b, exclude_vars)
  require 'json'
  h = {}
  b.local_variables.each do |name|
    next if exclude_vars.include?(name)
    begin
      val    = b.local_variable_get(name)
      val_id = (val.object_id rescue nil)
      h[name.to_s] = build_var_node(val, MAX_VAR_DEPTH, val_id ? [val_id] : [])
    rescue NoMemoryError, SystemStackError => e
      raise e
    rescue Exception
      h[name.to_s] = { 'value' => '<error reading>', 'type' => '?', 'children' => {} }
    end
  end
  # Write vars.json to temp dir alongside repl.rb (legacy file-watcher fallback)
  vars_file = File.join(File.dirname(File.expand_path(__FILE__)), 'vars.json')
  File.write(vars_file, h.to_json) rescue nil
  # Emit inline so the extension receives it via stdout
  puts "<<VARS>>#{h.to_json}"
rescue NoMemoryError, SystemStackError => e
  # These are severe — emit what we can and re-raise
  puts "<<ERROR>>#{e.class}: #{e.message} (variable snapshot skipped)"
rescue Exception => e
  # Never let variable emission crash the REPL
  puts "<<ERROR>>#{e.class}: Failed to snapshot variables: #{e.message}"
end

# ── Backtrace helpers ─────────────────────────────────────────────────────────

# Walk an exception's backtrace and return the first frame that refers to
# user code (i.e. not repl.rb internals).  Returns [file, line] or [nil, nil].
def find_user_frame(e)
  return [nil, nil] unless e.backtrace && !e.backtrace.empty?

  e.backtrace.each do |frame|
    # Skip repl.rb internal frames
    next if frame.include?(REPL_SCRIPT_PATH)
    next if frame =~ %r{[/\\]repl\.rb:\d+}

    if frame =~ /\A(.+?):(\d+)/
      file = $1
      line = $2.to_i
      # Skip single-line REPL wrapper — not useful to the user
      next if file == '(repl)' && line == 1
      return [file, line]
    end
  end
  [nil, nil]
end

# Read a single source line from a file.  Returns the line string or nil.
def read_source_line(file, line_num)
  return nil unless file && line_num && line_num > 0 && File.exist?(file.to_s)
  lines = File.readlines(file)
  line_num <= lines.length ? lines[line_num - 1].rstrip : nil
rescue Exception
  nil
end

# Clean the raw exception message: strip leading file:line prefixes that Ruby
# prepends to SyntaxError / eval messages so we can re-format them ourselves.
def clean_error_message(e)
  msg = e.message.to_s
  # Remove leading "(eval):N: " or "/path/to/file.rb:N: " prefix
  msg.sub(/\A(?:\(eval\)|[^:]+\.rb):\d+:\s*/, '')
end

# Build a location suffix like " (helper.rb:42)" from a backtrace frame.
# Shows just the basename so paths stay short in the REPL output.
def location_suffix(file, line)
  return '' unless file && line
  display = File.basename(file)
  " (#{display}:#{line})"
end

# Emit a source-line preview:  "   42 | some_code_here"
def emit_source_preview(file, line)
  src = read_source_line(file, line)
  puts "   #{line} | #{src}" if src
end

# Format a full error line for <<ERROR>> or <<SCRIPT_ERROR>> and emit
# an optional source preview.  Returns the formatted message string.
def format_and_preview_error(e, marker = '<<ERROR>>')
  file, line = find_user_frame(e)
  msg = clean_error_message(e)
  loc = location_suffix(file, line)
  puts "#{marker}#{e.class}: #{msg}#{loc}"
  emit_source_preview(file, line)
end

# ── Evaluation ────────────────────────────────────────────────────────────────

def evaluate_and_print(expr, b)
  result = eval(expr, b, '(repl)', 1)
  puts "<<RESULT>>#{value_str(result)}<<TYPE>>#{(result.class.to_s rescue '?')}"
rescue SystemExit, SignalException
  raise
rescue NoMemoryError => e
  format_and_preview_error(e)
rescue SystemStackError => e
  format_and_preview_error(e)
rescue SyntaxError => e
  format_and_preview_error(e)
rescue LoadError => e
  format_and_preview_error(e)
rescue NameError => e
  format_and_preview_error(e)
rescue TypeError => e
  format_and_preview_error(e)
rescue ArgumentError => e
  format_and_preview_error(e)
rescue ZeroDivisionError => e
  format_and_preview_error(e)
rescue RangeError => e
  format_and_preview_error(e)
rescue IOError, Errno::ENOENT, Errno::EACCES, Errno::EPERM => e
  format_and_preview_error(e)
rescue RegexpError => e
  format_and_preview_error(e)
rescue Encoding::UndefinedConversionError, Encoding::InvalidByteSequenceError => e
  format_and_preview_error(e)
rescue ThreadError => e
  format_and_preview_error(e)
rescue Interrupt
  puts "<<ERROR>>Interrupt: Execution was interrupted"
rescue Exception => e
  format_and_preview_error(e)
end

# ── Main REPL ─────────────────────────────────────────────────────────────────

def start_repl(ruby_file_path)
  repl_binding    = binding
  # Capture built-in locals before the user's script runs so they are excluded
  # from the Variables panel. :ruby_content is added explicitly because it is
  # assigned below (after the binding snapshot) but must still be hidden.
  pre_script_vars = repl_binding.local_variables + [:pre_script_vars, :ruby_content]

  ruby_content = File.read(ruby_file_path)
  puts "<<SCRIPT_START>>#{File.basename(ruby_file_path)}"
  begin
    # Pass the actual file path so backtraces show real locations, not "(eval)"
    eval(ruby_content, repl_binding, ruby_file_path, 1)
    puts '<<SCRIPT_DONE>>'
  rescue SystemExit, SignalException
    raise
  rescue NoMemoryError, SystemStackError, SyntaxError, LoadError => e
    format_and_preview_error(e, '<<SCRIPT_ERROR>>')
  rescue Exception => e
    format_and_preview_error(e, '<<SCRIPT_ERROR>>')
  end

  emit_vars(repl_binding, pre_script_vars)

  loop do
    puts '<<READY>>'
    begin
      input = STDIN.gets
    rescue IOError, Errno::EBADF, Errno::EPIPE => e
      puts "<<ERROR>>#{e.class}: STDIN closed unexpectedly (#{e.message})"
      break
    rescue Interrupt
      puts "<<ERROR>>Interrupt: Use 'exit' to quit the REPL"
      next
    end
    break unless input
    input = input.chomp
    next  if input.strip.empty?
    break if %w[exit quit].include?(input.strip.downcase)

    begin
      evaluate_and_print(input, repl_binding)
      emit_vars(repl_binding, pre_script_vars)
    rescue SystemExit, SignalException
      raise
    rescue NoMemoryError => e
      puts "<<ERROR>>NoMemoryError: #{e.message} — try freeing some variables"
    rescue SystemStackError => e
      puts "<<ERROR>>SystemStackError: #{e.message} — infinite recursion or stack too deep"
    rescue Interrupt
      puts "<<ERROR>>Interrupt: Execution was interrupted"
    rescue Exception => e
      puts "<<ERROR>>#{e.class}: #{e.message}"
    end
  end

  puts '<<EXIT>>'
rescue SystemExit, SignalException
  puts '<<EXIT>>'
  raise
rescue Exception => e
  # Last-resort catch: emit error + exit marker so extension knows we're done
  puts "<<ERROR>>Fatal: #{e.class}: #{e.message}"
  puts '<<EXIT>>'
end

# Top-level protection — if start_repl itself raises something unexpected,
# ensure we emit the EXIT marker so the extension doesn't hang.
begin
  start_repl(ruby_file_path)
rescue SystemExit => e
  puts '<<EXIT>>' unless e.success?
rescue SignalException
  puts '<<EXIT>>'
rescue Exception => e
  puts "<<ERROR>>Fatal (top-level): #{e.class}: #{e.message}"
  puts '<<EXIT>>'
end
