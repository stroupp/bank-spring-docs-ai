package fixture.customer;

import jakarta.validation.Valid;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/customers")
public class CustomerSearchController {
    private final CustomerService customerService;

    public CustomerSearchController(CustomerService customerService) {
        this.customerService = customerService;
    }

    @GetMapping(path = "/{customerId}")
    public ResponseEntity<CustomerResponse> getCustomer(
        @PathVariable("customerId") Long customerId,
        @RequestHeader(name = "X-Correlation-Id", required = false) String correlationId) {
        return ResponseEntity.ok(customerService.getCustomer(customerId));
    }

    @PreAuthorize("hasRole('CUSTOMER_READ')")
    @GetMapping(
        value = "/search"
    )
    public Page<CustomerResponse> searchCustomers(
        @RequestParam(defaultValue = "ACTIVE") String status,
        Pageable pageable) {
        return customerService.searchCustomers(status, pageable);
    }

    @PostMapping("/search")
    public ResponseEntity<CustomerResponse> create(@Valid @RequestBody CustomerSearchRequest request) {
        return ResponseEntity.ok(customerService.create(request));
    }

    @PutMapping("/{customerId}")
    public CustomerResponse update(@PathVariable Long customerId, @Valid @RequestBody CustomerSearchRequest request) {
        return customerService.update(customerId, request);
    }

    @DeleteMapping("/{customerId}")
    public void delete(@PathVariable Long customerId) {
        customerService.delete(customerId);
    }
}
