# desolate v3: the test tiers (move-to-vms.md section 13.2). See tests/v3/run.sh.
.PHONY: test format e2e-fast e2e-slow image
test:        ## T1: static and unit; seconds, anywhere
	./tests/v3/run.sh t1
format:      ## Prettier over the TypeScript, as the editor formats it on save (T1 checks it)
	git ls-files -z '*.ts' '*.mts' | xargs -0 node_modules/.bin/prettier --ignore-path .prettierignore --write --log-level warn
e2e-fast:    ## T2: end to end on the fake backend; minutes; needs Docker and the base image
	./tests/v3/run.sh t2
e2e-slow:    ## T3: end to end on real VMs (qemu); run whenever something structural changes
	./tests/v3/run.sh t3
image:       ## the base image, from the Ubuntu archive (Linux, as root); writes to ./image-out
	sudo release/image/build.sh --out image-out
